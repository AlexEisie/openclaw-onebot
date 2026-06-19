import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INBOUND_IMAGE_BYTES = 25 * 1024 * 1024;
const INBOUND_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INBOUND_IMAGE_FETCH_TIMEOUT_MS = 15 * 1000;

export interface InboundImageLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface InboundImageAttachment {
  source: string;
  url?: string;
  file?: string;
  summary?: string;
  subType?: string;
}

export interface StagedInboundImageAttachment extends InboundImageAttachment {
  mediaSource: string;
  contentType: string;
  localPath?: string;
}

function resolveInboundImageDir(): string {
  const configured = process.env.OPENCLAW_ONEBOT_INBOUND_MEDIA_DIR?.trim();
  if (configured) return configured;
  const home = homedir() || process.env.HOME || tmpdir();
  return join(home, ".openclaw", "media", "onebot", "inbound");
}

function segmentString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value);
  return text ? text : undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function stripFileScheme(value: string): string {
  if (!value.startsWith("file://")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return decodeURIComponent(value.replace(/^file:\/\//i, ""));
  }
}

function normalizeImageContentType(value: unknown): string | undefined {
  const raw = segmentString(value)?.split(";", 1)[0]?.trim().toLowerCase();
  if (!raw?.startsWith("image/")) return undefined;
  return raw === "image/jpg" ? "image/jpeg" : raw;
}

function imageExtensionForContentType(contentType: string): string | undefined {
  switch (contentType.toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "image/avif":
      return ".avif";
    default:
      return undefined;
  }
}

function imageContentTypeForExtension(source: string): string | undefined {
  const pathPart = source.split(/[?#]/, 1)[0] ?? source;
  switch (extname(pathPart).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".avif":
      return "image/avif";
    default:
      return undefined;
  }
}

export function inferInboundImageContentType(img: InboundImageAttachment): string {
  return imageContentTypeForExtension(img.file ?? img.url ?? img.source) ?? "image/png";
}

async function ensureInboundImageDir(): Promise<string> {
  const dir = resolveInboundImageDir();
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

async function pruneInboundImageDir(): Promise<void> {
  const dir = resolveInboundImageDir();
  const cutoff = Date.now() - INBOUND_IMAGE_MAX_AGE_MS;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const fullPath = join(dir, entry.name);
    try {
      const info = await stat(fullPath);
      if (info.mtimeMs < cutoff) {
        await rm(fullPath, { force: true });
      }
    } catch {
      // Best-effort cleanup only.
    }
  }));
}

async function resolveExistingLocalImage(img: InboundImageAttachment): Promise<StagedInboundImageAttachment | undefined> {
  const source = img.file ?? img.url ?? img.source;
  if (!source || isHttpUrl(source)) return undefined;
  const localPath = stripFileScheme(source);
  if (!isAbsolute(localPath)) return undefined;
  try {
    const info = await stat(localPath);
    if (!info.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return {
    ...img,
    mediaSource: localPath,
    localPath,
    contentType: inferInboundImageContentType(img),
  };
}

async function downloadImageToLocalPath(
  img: InboundImageAttachment,
  log?: InboundImageLog,
): Promise<StagedInboundImageAttachment> {
  const source = img.url ?? img.source;
  const fallbackContentType = inferInboundImageContentType(img);
  if (!source || !isHttpUrl(source)) {
    return { ...img, mediaSource: img.source, contentType: fallbackContentType };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INBOUND_IMAGE_FETCH_TIMEOUT_MS);
    const response = await fetch(source, { signal: controller.signal }).finally(() => {
      clearTimeout(timeout);
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INBOUND_IMAGE_BYTES) {
      throw new Error(`image too large: ${declaredLength} bytes`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("empty image response");
    }
    if (buffer.length > MAX_INBOUND_IMAGE_BYTES) {
      throw new Error(`image too large: ${buffer.length} bytes`);
    }

    const contentType = normalizeImageContentType(response.headers.get("content-type")) ?? fallbackContentType;
    const ext = imageExtensionForContentType(contentType)
      || extname((img.file ?? new URL(source).pathname).split(/[?#]/, 1)[0] ?? "")
      || ".img";
    const safeBase = basename(img.file ?? "image", ext)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image";
    const dir = await ensureInboundImageDir();
    const localPath = join(dir, `${Date.now()}-${randomUUID()}-${safeBase}${ext}`);

    await writeFile(localPath, buffer);
    await chmod(localPath, 0o600).catch(() => {});
    void pruneInboundImageDir().catch(() => {});
    log?.debug?.(`[onebot] Downloaded inbound image: ${localPath} (${buffer.length} bytes, ${contentType})`);

    return {
      ...img,
      mediaSource: localPath,
      localPath,
      contentType,
    };
  } catch (err) {
    log?.debug?.(`[onebot] Failed to download inbound image ${source.slice(0, 120)}: ${String(err)}`);
    return {
      ...img,
      mediaSource: img.source,
      contentType: fallbackContentType,
    };
  }
}

export async function stageInboundImageAttachments(
  images: InboundImageAttachment[],
  log?: InboundImageLog,
): Promise<StagedInboundImageAttachment[]> {
  const staged: StagedInboundImageAttachment[] = [];
  for (const img of images) {
    const local = await resolveExistingLocalImage(img);
    staged.push(local ?? await downloadImageToLocalPath(img, log));
  }
  return staged;
}
