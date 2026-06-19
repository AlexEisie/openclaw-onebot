import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayContext, OneBotFileAttachment } from "./gateway.js";
import { getFile, getGroupFileUrl, getPrivateFileUrl } from "./outbound.js";
import type { OneBotMessageEvent, OneBotMessageSegment, OneBotApiResponse, ResolvedOneBotAccount } from "./types.js";

const MAX_INLINE_TEXT_BYTES = 64 * 1024;
const MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024;
const INBOUND_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INBOUND_FILE_FETCH_TIMEOUT_MS = 30 * 1000;

function segmentString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value);
  return text ? text : undefined;
}

function inferFileMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".torrent")) return "application/x-bittorrent";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function resolveInboundFileDir(): string {
  const configured = process.env.OPENCLAW_ONEBOT_INBOUND_FILE_DIR?.trim();
  if (configured) return configured;
  const home = homedir() || process.env.HOME || tmpdir();
  return join(home, ".openclaw", "media", "onebot", "inbound-files");
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

function firstHttpUrl(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value && isHttpUrl(value)));
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value));
}

function isTextFileContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType === "application/json"
    || contentType === "application/xml";
}

function extractFileDataFromApiResponse(result: OneBotApiResponse): Record<string, unknown> {
  return result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
}

function decodeBase64Text(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    return undefined;
  }
}

async function downloadTextFile(url: string): Promise<string | undefined> {
  const response = await fetch(url);
  if (!response.ok) return undefined;
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_INLINE_TEXT_BYTES) return undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_INLINE_TEXT_BYTES) return undefined;
  return buffer.toString("utf8").trim();
}

async function loadLocalTextFile(path: string): Promise<string | undefined> {
  const normalized = path.replace(/^file:\/\//i, "");
  const info = await stat(normalized);
  if (!info.isFile() || info.size > MAX_INLINE_TEXT_BYTES) return undefined;
  return (await readFile(normalized, "utf8")).trim();
}

async function ensureInboundFileDir(): Promise<string> {
  const dir = resolveInboundFileDir();
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

async function pruneInboundFileDir(): Promise<void> {
  const dir = resolveInboundFileDir();
  const cutoff = Date.now() - INBOUND_FILE_MAX_AGE_MS;
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

async function resolveExistingLocalFile(source: string): Promise<string | undefined> {
  if (isHttpUrl(source)) return undefined;
  const localPath = stripFileScheme(source);
  if (!isAbsolute(localPath)) return undefined;
  try {
    const info = await stat(localPath);
    return info.isFile() ? localPath : undefined;
  } catch {
    return undefined;
  }
}

async function stageRemoteFile(
  attachment: OneBotFileAttachment,
  log?: GatewayContext["log"],
): Promise<string | undefined> {
  const source = attachment.source;
  if (!source || !isHttpUrl(source)) return undefined;
  if ((attachment.size ?? 0) > MAX_INBOUND_FILE_BYTES) return undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INBOUND_FILE_FETCH_TIMEOUT_MS);
    const response = await fetch(source, { signal: controller.signal }).finally(() => {
      clearTimeout(timeout);
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INBOUND_FILE_BYTES) {
      throw new Error(`file too large: ${declaredLength} bytes`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_INBOUND_FILE_BYTES) {
      throw new Error(`file too large: ${buffer.length} bytes`);
    }

    const ext = extname(attachment.name) || ".bin";
    const safeBase = basename(attachment.name, ext)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "file";
    const dir = await ensureInboundFileDir();
    const localPath = join(dir, `${Date.now()}-${randomUUID()}-${safeBase}${ext}`);
    await writeFile(localPath, buffer);
    await chmod(localPath, 0o600).catch(() => {});
    attachment.size = buffer.length;
    void pruneInboundFileDir().catch(() => {});
    log?.debug?.(`[onebot] Downloaded inbound file: ${localPath} (${buffer.length} bytes)`);
    return localPath;
  } catch (err) {
    log?.debug?.(`[onebot] Failed to download inbound file ${source.slice(0, 120)}: ${String(err)}`);
    return undefined;
  }
}

async function stageFileAttachment(
  attachment: OneBotFileAttachment,
  log?: GatewayContext["log"],
): Promise<void> {
  if (!attachment.source) return;
  attachment.localPath = await resolveExistingLocalFile(attachment.source)
    ?? await stageRemoteFile(attachment, log);
}

async function resolveFileUrl(
  account: ResolvedOneBotAccount,
  event: OneBotMessageEvent,
  seg: OneBotMessageSegment,
  fileId?: string,
): Promise<string | undefined> {
  if (!fileId) return undefined;
  if (event.message_type === "group" && event.group_id != null) {
    const busid = segmentString(seg.data.busid ?? seg.data.busId);
    const result = await getGroupFileUrl(account, event.group_id, fileId, busid);
    const data = extractFileDataFromApiResponse(result);
    return segmentString(data.url ?? data.file ?? data.path);
  }
  const result = await getPrivateFileUrl(account, fileId);
  const data = extractFileDataFromApiResponse(result);
  return segmentString(data.url ?? data.file ?? data.path);
}

export async function loadFileAttachments(
  account: ResolvedOneBotAccount,
  event: OneBotMessageEvent,
  log?: GatewayContext["log"],
): Promise<OneBotFileAttachment[]> {
  const attachments: OneBotFileAttachment[] = [];

  for (const seg of event.message.filter((segment) => segment.type === "file")) {
    const name = segmentString(seg.data.name ?? seg.data.file) ?? "file";
    const fileId = segmentString(seg.data.file_id ?? seg.data.fileId);
    const file = segmentString(seg.data.file);
    const segmentUrl = segmentString(seg.data.url);
    const declaredSize = Number(seg.data.file_size ?? seg.data.fileSize);
    const attachment: OneBotFileAttachment = {
      name,
      contentType: inferFileMimeType(name),
      ...(Number.isFinite(declaredSize) ? { size: declaredSize } : {}),
    };
    attachment.source = segmentUrl;

    if (!fileId && !file) {
      attachments.push(attachment);
      continue;
    }

    try {
      const result = await getFile(account, { fileId, file });
      const data = extractFileDataFromApiResponse(result);
      const url = segmentString(data.url);
      const path = segmentString(data.file ?? data.path);
      attachment.source = firstHttpUrl(segmentUrl, url, path) ?? firstPresent(attachment.source, path, url);
      const loadedName = segmentString(data.file_name ?? data.fileName ?? data.name);
      if (loadedName) attachment.name = loadedName;
      attachment.contentType = inferFileMimeType(attachment.name);
      const loadedSize = Number(data.file_size ?? data.fileSize);
      if (Number.isFinite(loadedSize)) attachment.size = loadedSize;
      log?.debug?.(`[onebot:${account.accountId}] Loaded file metadata ${attachment.name}: fields=${Object.keys(data).join(",") || "none"}`);
      if (isTextFileContentType(attachment.contentType) && (attachment.size ?? 0) <= MAX_INLINE_TEXT_BYTES) {
        attachment.text = decodeBase64Text(data.base64);
      }
    } catch (err) {
      log?.debug?.(`[onebot:${account.accountId}] Failed to load file ${fileId ?? file ?? name}: ${String(err)}`);
    }

    if (!attachment.source || !isHttpUrl(attachment.source)) {
      try {
        attachment.source = await resolveFileUrl(account, event, seg, fileId) ?? attachment.source;
      } catch (err) {
        log?.debug?.(`[onebot:${account.accountId}] Failed to resolve file url ${fileId ?? file ?? name}: ${String(err)}`);
      }
    }

    await stageFileAttachment(attachment, log);

    if (!attachment.text && (attachment.localPath || attachment.source) && isTextFileContentType(attachment.contentType) && (attachment.size ?? 0) <= MAX_INLINE_TEXT_BYTES) {
      try {
        const textSource = attachment.localPath ?? attachment.source!;
        attachment.text = textSource.startsWith("http")
          ? await downloadTextFile(textSource)
          : await loadLocalTextFile(textSource);
      } catch (err) {
        log?.debug?.(`[onebot:${account.accountId}] Failed to read file text ${attachment.name}: ${String(err)}`);
      }
    }

    attachments.push(attachment);
  }

  return attachments;
}
