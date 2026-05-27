import { readFile, stat } from "node:fs/promises";
import type { GatewayContext, OneBotFileAttachment } from "./gateway.js";
import { getFile, getGroupFileUrl, getPrivateFileUrl } from "./outbound.js";
import type { OneBotMessageEvent, OneBotMessageSegment, OneBotApiResponse, ResolvedOneBotAccount } from "./types.js";

const MAX_INLINE_TEXT_BYTES = 64 * 1024;

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
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
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
    const declaredSize = Number(seg.data.file_size ?? seg.data.fileSize);
    const attachment: OneBotFileAttachment = {
      name,
      contentType: inferFileMimeType(name),
      ...(Number.isFinite(declaredSize) ? { size: declaredSize } : {}),
    };

    if (!fileId && !file) {
      attachments.push(attachment);
      continue;
    }

    try {
      const result = await getFile(account, { fileId, file });
      const data = extractFileDataFromApiResponse(result);
      const url = segmentString(data.url);
      const path = segmentString(data.file ?? data.path);
      attachment.source = url ?? path;
      const loadedName = segmentString(data.file_name ?? data.fileName ?? data.name);
      if (loadedName) attachment.name = loadedName;
      const loadedSize = Number(data.file_size ?? data.fileSize);
      if (Number.isFinite(loadedSize)) attachment.size = loadedSize;
      log?.debug?.(`[onebot:${account.accountId}] Loaded file metadata ${attachment.name}: fields=${Object.keys(data).join(",") || "none"}`);
      if (isTextFileContentType(attachment.contentType) && (attachment.size ?? 0) <= MAX_INLINE_TEXT_BYTES) {
        attachment.text = decodeBase64Text(data.base64);
      }
    } catch (err) {
      log?.debug?.(`[onebot:${account.accountId}] Failed to load file ${fileId ?? file ?? name}: ${String(err)}`);
    }

    if (!attachment.source) {
      try {
        attachment.source = await resolveFileUrl(account, event, seg, fileId);
      } catch (err) {
        log?.debug?.(`[onebot:${account.accountId}] Failed to resolve file url ${fileId ?? file ?? name}: ${String(err)}`);
      }
    }

    if (!attachment.text && attachment.source && isTextFileContentType(attachment.contentType) && (attachment.size ?? 0) <= MAX_INLINE_TEXT_BYTES) {
      try {
        attachment.text = attachment.source.startsWith("http")
          ? await downloadTextFile(attachment.source)
          : await loadLocalTextFile(attachment.source);
      } catch (err) {
        log?.debug?.(`[onebot:${account.accountId}] Failed to read file text ${attachment.name}: ${String(err)}`);
      }
    }

    attachments.push(attachment);
  }

  return attachments;
}
