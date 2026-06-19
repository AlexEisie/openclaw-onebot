import WebSocket from "ws";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type {
  ResolvedOneBotAccount,
  OneBotApiResponse,
  OneBotEvent,
  OneBotMessageEvent,
  OneBotMessageSegment,
} from "./types.js";
import { getOneBotRuntime } from "./runtime.js";
import { getMessage, reactToMessage, sendText as sendOutboundText, sendImage, sendRecord } from "./outbound.js";
import { cleanupVoiceFiles, processVoiceSegments } from "./voice.js";
import { loadFileAttachments } from "./inbound-file.js";
import { stageInboundImageAttachments } from "./inbound-image.js";
export {
  cleanupVoiceFiles,
  convertAmrToMp3,
  convertSilkToMp3,
  downloadVoiceFile,
  ensureVoiceTmpDir,
  isAmrFormat,
  isSilkFormat,
  processVoiceSegments,
} from "./voice.js";

// Reconnect configuration
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_RECONNECT_ATTEMPTS = 100;

// Message batching — keep enough gap for rapid fragments without holding single messages long.
export const BATCH_GAP_MS = 300;
const BATCH_MAX_MESSAGES = 12;
const BATCH_MAX_CHARS = 50000;
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

export interface GatewayContext {
  account: ResolvedOneBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// ── Text / image extraction ──

export interface OneBotImageAttachment {
  source: string;
  url?: string;
  file?: string;
  summary?: string;
  subType?: string;
}

export interface OneBotFileAttachment {
  name: string;
  source?: string;
  localPath?: string;
  contentType: string;
  size?: number;
  text?: string;
}

interface InboundMediaEntry {
  source: string;
  type: string;
  path?: string;
  url?: string;
}

interface RepliedMessageContext {
  messageId: string;
  text?: string;
  imageAttachments: OneBotImageAttachment[];
  fileAttachments: OneBotFileAttachment[];
}

function segmentString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value);
  return text ? text : undefined;
}

function formatAtSegment(data: Record<string, unknown>): string {
  const qq = String(data.qq ?? "");
  const label = qq === "all" ? "all" : qq;
  const name = segmentString(data.name);
  return name ? `[at:${label} ${name}]` : `[at:${label}]`;
}

function formatVisibleMention(data: Record<string, unknown>): string {
  const qq = String(data.qq ?? "").trim();
  const label = qq === "all" ? "all members" : qq;
  const name = segmentString(data.name);
  return name ? `[mentioned user ${label} ${name}]` : `[mentioned user ${label}]`;
}

export function extractTextForEvent(event: OneBotMessageEvent): string {
  const selfId = String(event.self_id);
  return event.message.map((seg) => {
    if (seg.type === "at") {
      return String(seg.data.qq ?? "") === selfId ? "" : formatVisibleMention(seg.data);
    }
    return extractText([seg]);
  }).join("");
}

function extractReplyMessageIds(segments: OneBotMessageSegment[]): Array<string | number> {
  return segments
    .filter((seg) => seg.type === "reply")
    .map((seg) => seg.data.id)
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
}

function readMessageSegmentsFromApiResponse(result: OneBotApiResponse): OneBotMessageSegment[] {
  const data = result.data as { message?: unknown } | null;
  return Array.isArray(data?.message) ? data.message as OneBotMessageSegment[] : [];
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function formatRepliedMessageText(messageId: string, result: OneBotApiResponse, segments: OneBotMessageSegment[]): string | undefined {
  const text = extractText(segments).trim();
  if (!text) return undefined;

  const data = result.data as { sender?: { card?: unknown; nickname?: unknown; user_id?: unknown } } | null;
  const sender = data?.sender;
  const senderName = segmentString(sender?.card) ?? segmentString(sender?.nickname) ?? segmentString(sender?.user_id);
  const from = senderName ? ` from ${senderName}` : "";
  return `[replied message ${messageId}${from}]: ${text}`;
}

async function loadRepliedMessageContexts(
  account: ResolvedOneBotAccount,
  event: OneBotMessageEvent,
  log?: GatewayContext["log"],
): Promise<RepliedMessageContext[]> {
  const seen = new Set<string>();
  const contexts: RepliedMessageContext[] = [];

  for (const messageId of extractReplyMessageIds(event.message)) {
    const dedupeKey = String(messageId);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    try {
      const result = await getMessage(account, messageId);
      const repliedSegments = readMessageSegmentsFromApiResponse(result);
      const repliedEvent = buildRepliedMessageEvent(event, result, dedupeKey, repliedSegments);
      contexts.push({
        messageId: dedupeKey,
        text: formatRepliedMessageText(dedupeKey, result, repliedSegments),
        imageAttachments: extractImageAttachments(repliedSegments),
        fileAttachments: repliedSegments.some((segment) => segment.type === "file")
          ? await loadFileAttachments(account, repliedEvent, log)
          : [],
      });
    } catch (err) {
      log?.debug?.(`[onebot:${account.accountId}] Failed to load replied message ${dedupeKey}: ${String(err)}`);
    }
  }

  return contexts;
}

function buildRepliedMessageEvent(
  parentEvent: OneBotMessageEvent,
  result: OneBotApiResponse,
  messageId: string,
  segments: OneBotMessageSegment[],
): OneBotMessageEvent {
  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : {};
  const messageType = data.message_type === "private" || data.message_type === "group"
    ? data.message_type
    : parentEvent.message_type;
  const groupId = Number(data.group_id ?? parentEvent.group_id);
  const sender = data.sender && typeof data.sender === "object"
    ? data.sender as OneBotMessageEvent["sender"]
    : parentEvent.sender;

  return {
    post_type: "message",
    message_type: messageType,
    sub_type: segmentString(data.sub_type) ?? "normal",
    message_id: Number(data.message_id ?? messageId) || parentEvent.message_id,
    user_id: Number(data.user_id ?? sender.user_id ?? parentEvent.user_id) || parentEvent.user_id,
    ...(messageType === "group" && Number.isFinite(groupId) ? { group_id: groupId } : {}),
    message: segments,
    raw_message: segmentString(data.raw_message) ?? "",
    sender,
    self_id: Number(data.self_id ?? parentEvent.self_id) || parentEvent.self_id,
    time: Number(data.time ?? parentEvent.time) || parentEvent.time,
  };
}

export function extractText(segments: OneBotMessageSegment[]): string {
  return segments.map((seg) => {
    switch (seg.type) {
      case "text":
        return String(seg.data.text ?? "");
      case "at":
        return formatAtSegment(seg.data);
      case "face":
        return `[face:${String(seg.data.id ?? "")}]`;
      case "reply":
        return `[reply:${String(seg.data.id ?? "")}]`;
      case "image":
        return "";
      case "record":
        return "";
      case "video":
        return `[Video: ${String(seg.data.url ?? seg.data.file ?? "")}]`;
      case "file":
        return "";
      case "share":
        return `[Share: ${String(seg.data.title ?? "")} ${String(seg.data.url ?? "")}]`;
      case "location":
        return `[Location: ${String(seg.data.lat ?? "")},${String(seg.data.lon ?? "")} ${String(seg.data.title ?? "")}]`;
      case "json":
        return `[JSON: ${String(seg.data.data ?? "")}]`;
      case "xml":
        return `[XML: ${String(seg.data.data ?? "")}]`;
      default:
        return `[${seg.type}]`;
    }
  }).join("");
}

export function extractImageAttachments(segments: OneBotMessageSegment[]): OneBotImageAttachment[] {
  return segments
    .filter((seg) => seg.type === "image")
    .map((seg) => {
      const url = segmentString(seg.data.url);
      const file = segmentString(seg.data.file);
      const source = url ?? file ?? "";
      const attachment: OneBotImageAttachment = { source };
      if (url) attachment.url = url;
      if (file) attachment.file = file;
      const summary = segmentString(seg.data.summary);
      if (summary) attachment.summary = summary;
      const subType = segmentString(seg.data.sub_type ?? seg.data.subType);
      if (subType) attachment.subType = subType;
      return attachment;
    })
    .filter((attachment) => attachment.source);
}

export function extractImages(segments: OneBotMessageSegment[]): string[] {
  return extractImageAttachments(segments).map((attachment) => attachment.source);
}

export function extractRecordSegments(segments: OneBotMessageSegment[]): OneBotMessageSegment[] {
  return segments.filter((seg) => seg.type === "record");
}

export function extractVideos(segments: OneBotMessageSegment[]): string[] {
  return segments
    .filter((seg) => seg.type === "video")
    .map((seg) => String(seg.data.url ?? seg.data.file ?? ""))
    .filter(Boolean);
}

export function isMentioningSelf(event: OneBotMessageEvent): boolean {
  const selfId = String(event.self_id);
  return event.message.some((segment) =>
    segment.type === "at" && String(segment.data.qq ?? "") === selfId
  );
}

export async function withSessionLock<T>(
  locks: Map<string, Promise<void>>,
  sessionKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  locks.set(sessionKey, next);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();
    if (locks.get(sessionKey) === next) {
      locks.delete(sessionKey);
    }
  }
}

// ── Message batching ──

interface BufferedMessage {
  event: OneBotMessageEvent;
  text: string;
  replyContextText: string[];
  images: string[];
  imageAttachments: OneBotImageAttachment[];
  fileAttachments: OneBotFileAttachment[];
  videos: string[];
  recordSegments: OneBotMessageSegment[];
  receivedAt: number;
}

interface ChatBatch {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout>;
  totalChars: number;
}

export function resolveInboundCommandAuthorization(params: {
  pluginRuntime: ReturnType<typeof getOneBotRuntime>;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  peerId: string;
}): boolean {
  const { pluginRuntime, cfg, allowFrom, peerId } = params;
  const hasAllowFrom = Array.isArray(allowFrom) && allowFrom.length > 0;
  const senderAllowedForCommands = hasAllowFrom
    && allowFrom.some((pattern) => peerId === pattern || pattern === "*");
  const resolveCommandAuthorized =
    pluginRuntime.channel.commands?.resolveCommandAuthorizedFromAuthorizers;

  if (typeof resolveCommandAuthorized !== "function") {
    return senderAllowedForCommands;
  }

  return resolveCommandAuthorized({
    useAccessGroups: cfg.commands?.useAccessGroups !== false,
    authorizers: [
      {
        configured: hasAllowFrom,
        allowed: senderAllowedForCommands,
      },
    ],
    modeWhenAccessGroupsOff: hasAllowFrom ? "configured" : "deny",
  });
}

// ── Gateway ──

export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.wsUrl) {
    throw new Error("OneBot not configured (missing wsUrl)");
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-chat message batch buffers
  const chatBatches = new Map<string, ChatBatch>();
  const sessionLocks = new Map<string, Promise<void>>();

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Flush all pending batches
    for (const [key, batch] of chatBatches) {
      clearTimeout(batch.timer);
      chatBatches.delete(key);
    }
    sessionLocks.clear();
    cleanup();
  });

  const cleanup = () => {
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[onebot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[onebot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    if (isConnecting) {
      log?.debug?.(`[onebot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      const wsUrl = account.wsUrl;
      const wsOptions: WebSocket.ClientOptions = {};

      let connectUrl = wsUrl;
      if (account.accessToken) {
        const separator = wsUrl.includes("?") ? "&" : "?";
        connectUrl = `${wsUrl}${separator}access_token=${account.accessToken}`;
      }

      log?.info(`[onebot:${account.accountId}] Connecting to ${wsUrl}`);

      const ws = new WebSocket(connectUrl, wsOptions);
      currentWs = ws;

      const pluginRuntime = getOneBotRuntime();

      // ── Dispatch a (possibly batched) set of messages ──

      const dispatchMessagesUnlocked = async (batchKey: string, messages: BufferedMessage[]) => {
        if (messages.length === 0) return;

        const first = messages[0];
        const last = messages[messages.length - 1];
        const event = first.event;
        log?.debug?.(
          `[onebot:${account.accountId}] Dispatching ${messages.length} buffered message(s) for ${batchKey} after ${Date.now() - first.receivedAt}ms`,
        );
        const isGroup = event.message_type === "group";
        const senderId = String(event.user_id);
        const senderName = event.sender.card || event.sender.nickname || senderId;

        // Combine text, images, and record segments from all buffered messages
        const combinedText = messages.map((m) => m.text).filter(Boolean).join("\n");
        const combinedReplyContextText = messages.flatMap((m) => m.replyContextText).filter(Boolean).join("\n");
        const combinedImages = messages.flatMap((m) => m.images);
        const combinedImageAttachments = messages.flatMap((m) => m.imageAttachments);
        const combinedFileAttachments = messages.flatMap((m) => m.fileAttachments);
        const combinedVideos = messages.flatMap((m) => m.videos);
        const combinedRecordSegs = messages.flatMap((m) => m.recordSegments);

        if (messages.length > 1) {
          log?.info(
            `[onebot:${account.accountId}] Batched ${messages.length} messages from ${senderName}: ${combinedText.slice(0, 100)}`,
          );
        }

        pluginRuntime.channel.activity.record({
          channel: "onebot",
          accountId: account.accountId,
          direction: "inbound",
        });

        const peerId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "onebot",
          accountId: account.accountId,
          peer: {
            kind: isGroup ? "group" : "direct",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // Process voice segments → download, convert SILK, get local paths
        const voiceMedia = await processVoiceSegments(combinedRecordSegs, log);
        const voiceFilePaths = voiceMedia.map((v) => v.path);
        const stagedImageAttachments = await stageInboundImageAttachments(combinedImageAttachments, log);

        // Build text body — images as placeholders, voice handled via MediaPath
        let attachmentInfo = "";
        let agentAttachmentInfo = "";
        for (const img of combinedImageAttachments) {
          const suffix = img.summary ? ` ${img.summary}` : "";
          attachmentInfo += `\n[Image: ${img.source}${suffix}]`;
          agentAttachmentInfo += `\n[Image attached${suffix}]`;
        }
        for (const video of combinedVideos) {
          attachmentInfo += `\n[Video: ${video}]`;
          agentAttachmentInfo += `\n[Video attached]`;
        }
        for (const file of combinedFileAttachments) {
          const suffix = file.size != null ? ` ${file.size} bytes` : "";
          attachmentInfo += `\n[File: ${file.name}${suffix}]`;
          agentAttachmentInfo += `\n[File: ${file.name}${suffix}]`;
          const fileLocation = file.localPath ?? file.source;
          if (fileLocation) {
            attachmentInfo += `\n[File ${file.localPath ? "local path" : "source"}: ${fileLocation}]`;
            agentAttachmentInfo += `\n[File ${file.localPath ? "local path" : "source"}: ${fileLocation}]`;
          }
          if (file.text) {
            attachmentInfo += `\n${file.text}`;
            agentAttachmentInfo += `\n${file.text}`;
          }
        }
        if (voiceMedia.length > 0) {
          attachmentInfo += "\n<media:audio>";
          agentAttachmentInfo += "\n<media:audio>";
        } else if (combinedRecordSegs.length > 0) {
          // Voice download/conversion failed — add text placeholder
          attachmentInfo += "\n[语音]";
          agentAttachmentInfo += "\n[语音]";
        }

        const textWithReplyContext = [combinedReplyContextText, combinedText].filter(Boolean).join("\n");
        const userContent = textWithReplyContext + attachmentInfo;
        const agentContent = textWithReplyContext + agentAttachmentInfo;
        const agentBody = agentContent.trim() ? agentContent : combinedText;

        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "OneBot",
          from: senderName,
          timestamp: last.event.time * 1000,
          body: userContent,
          chatType: isGroup ? "group" : "direct",
          sender: {
            id: senderId,
            name: senderName,
          },
          envelope: envelopeOptions,
          ...(combinedImages.length > 0 ? { imageUrls: combinedImages } : {}),
          ...(combinedImageAttachments.length > 0 ? { imageAttachments: combinedImageAttachments } : {}),
        });

        const fromAddress = isGroup
          ? `onebot:group:${event.group_id}`
          : `onebot:private:${senderId}`;
        const toAddress = fromAddress;
        const commandAuthorized = resolveInboundCommandAuthorization({
          pluginRuntime,
          cfg,
          allowFrom: account.allowFrom,
          peerId,
        });

        // Build media payload for OpenClaw's unified media pipeline.
        const mediaEntries: InboundMediaEntry[] = [
          ...stagedImageAttachments.map((img) => ({
            source: img.mediaSource,
            type: img.contentType,
            ...(img.localPath ? { path: img.localPath } : {}),
          })),
          ...combinedFileAttachments
            .filter((file): file is OneBotFileAttachment & { source: string } => Boolean(file.source))
            .map((file) => ({
              source: file.source,
              type: file.contentType,
              ...(file.localPath ? { path: file.localPath } : {}),
              ...(isHttpUrl(file.source) ? { url: file.source } : {}),
            })),
          ...voiceMedia.map((v) => ({ source: v.path, type: v.contentType, path: v.path })),
        ].filter((entry) => entry.source);
        const mediaPayload: Record<string, unknown> = {};
        if (mediaEntries.length > 0) {
          const mediaPaths = mediaEntries.every((entry) => Boolean(entry.path))
            ? mediaEntries.map((entry) => entry.path).filter((entry): entry is string => Boolean(entry))
            : [];
          const mediaUrls = mediaEntries.map((entry) => entry.url ?? entry.source);
          const mediaTypes = mediaEntries.map((entry) => entry.type);
          mediaPayload.MediaUrl = mediaEntries[0].source;
          mediaPayload.MediaType = mediaEntries[0].type;
          if (mediaEntries.length > 1) mediaPayload.MediaUrls = mediaUrls;
          mediaPayload.MediaTypes = mediaTypes;
          mediaPayload.mediaUrl = mediaEntries[0].source;
          mediaPayload.mediaType = mediaEntries[0].type;
          if (mediaEntries.length > 1) mediaPayload.mediaUrls = mediaUrls;
          mediaPayload.mediaTypes = mediaTypes;
          if (mediaPaths.length > 0) {
            mediaPayload.MediaPath = mediaPaths[0];
            mediaPayload.mediaPath = mediaPaths[0];
            if (mediaPaths.length > 1) {
              mediaPayload.MediaPaths = mediaPaths;
              mediaPayload.mediaPaths = mediaPaths;
            }
          }
        }

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: combinedText,
          CommandBody: combinedText,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroup ? "group" : "direct",
          SenderId: senderId,
          SenderName: senderName,
          Provider: "onebot",
          Surface: "onebot",
          MessageSid: String(last.event.message_id),
          Timestamp: last.event.time * 1000,
          CommandAuthorized: commandAuthorized,
          CommandSource: "text",
          OriginatingChannel: "onebot",
          OriginatingTo: toAddress,
          ...mediaPayload,
        });

        log?.info(
          `[onebot:${account.accountId}] ctxPayload: From=${fromAddress}, SessionKey=${route.sessionKey}, ChatType=${isGroup ? "group" : "direct"}, hasAudio=${voiceMedia.length > 0}`,
        );
        log?.info(`[onebot:${account.accountId}] OpenClaw source text:\n${String(ctxPayload.BodyForAgent ?? ctxPayload.Body ?? "")}`);

        const sendErrorMessage = async (errorText: string) => {
          try {
            await sendOutboundText({ to: fromAddress, text: errorText, account });
          } catch (sendErr) {
            log?.error(`[onebot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          let hasResponse = false;
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let removeAbortListener: (() => void) | undefined;

          const clearResponseTimeout = () => {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
          };

          const abortPromise = new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            const onAbort = () => resolve();
            abortSignal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
          });

          timeoutId = setTimeout(() => {
            timeoutId = null;
            if (hasResponse || abortSignal.aborted) return;
            log?.info(`[onebot:${account.accountId}] No response within timeout; continuing to wait`);
            void sendErrorMessage("[OpenClaw] Request received, processing...");
          }, RESPONSE_TIMEOUT_MS);

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (
                payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
                info: { kind: string },
              ) => {
                if (abortSignal.aborted) return;
                hasResponse = true;
                clearResponseTimeout();

                log?.info(
                  `[onebot:${account.accountId}] deliver(${info.kind}): textLen=${payload.text?.length ?? 0}`,
                );

                let replyText = payload.text ?? "";
                let audioSendFailed = false;

                const mediaPaths: string[] = [];
                if (payload.mediaUrls?.length) mediaPaths.push(...payload.mediaUrls);
                if (payload.mediaUrl && !mediaPaths.includes(payload.mediaUrl)) {
                  mediaPaths.push(payload.mediaUrl);
                }

                const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac", ".aac", ".opus", ".amr", ".silk"]);
                for (const mediaPath of mediaPaths) {
                  const ext = mediaPath.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");
                  try {
                    const targetType = isGroup ? "group" as const : "private" as const;
                    const targetId = isGroup ? event.group_id! : event.user_id;
                    if (AUDIO_EXTS.has(ext)) {
                      const result = await sendRecord(account, targetType, targetId, mediaPath);
                      const sentId = (result.data as { message_id?: number } | null)?.message_id;
                      log?.info(`[onebot:${account.accountId}] Sent voice: ${mediaPath}${sentId != null ? ` message_id=${sentId}` : ''}`);
                    } else {
                      const result = await sendImage(account, targetType, targetId, mediaPath);
                      const sentId = (result.data as { message_id?: number } | null)?.message_id;
                      log?.info(`[onebot:${account.accountId}] Sent media: ${mediaPath}${sentId != null ? ` message_id=${sentId}` : ''}`);
                    }
                  } catch (err) {
                    if (AUDIO_EXTS.has(ext)) {
                      audioSendFailed = true;
                    }
                    log?.error(`[onebot:${account.accountId}] Media send failed: ${err}`);
                  }
                }

                if (audioSendFailed && !replyText.trim()) {
                  replyText = '[OpenClaw] 语音回复发送失败，已切换为文本提醒。';
                }

                if (replyText.trim()) {
                  try {
                    await sendOutboundText({ to: fromAddress, text: replyText, account });
                    pluginRuntime.channel.activity.record({
                      channel: "onebot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                  } catch (err) {
                    log?.error(`[onebot:${account.accountId}] Send failed: ${err}`);
                  }
                }
              },
              onError: async (err: unknown) => {
                if (abortSignal.aborted) return;
                log?.error(`[onebot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                clearResponseTimeout();
                await sendErrorMessage(`[OpenClaw] Error: ${String(err).slice(0, 500)}`);
              },
            },
            replyOptions: {},
          });

          try {
            await Promise.race([dispatchPromise, abortPromise]);
          } finally {
            clearResponseTimeout();
            removeAbortListener?.();
          }
        } catch (err) {
          log?.error(`[onebot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`[OpenClaw] Processing failed: ${String(err).slice(0, 500)}`);
        } finally {
          // Cleanup temp voice files after dispatch
          cleanupVoiceFiles(voiceFilePaths);
        }
      };

      // ── Buffer an incoming message and debounce dispatch ──

      const dispatchMessages = async (batchKey: string, messages: BufferedMessage[]) => {
        if (messages.length === 0) return;

        const event = messages[0].event;
        const sessionKey = event.message_type === "group"
          ? `group:${event.group_id}`
          : `private:${event.user_id}`;

        if (sessionLocks.has(sessionKey)) {
          log?.debug?.(`[onebot:${account.accountId}] Waiting for session lock: ${sessionKey}`);
        }

        await withSessionLock(sessionLocks, sessionKey, () => dispatchMessagesUnlocked(batchKey, messages));
      };

      const bufferMessage = async (event: OneBotMessageEvent) => {
        const receivedAt = Date.now();
        const isGroup = event.message_type === "group";
        const senderId = String(event.user_id);
        const senderName = event.sender.card || event.sender.nickname || senderId;
        const text = extractTextForEvent(event) || event.raw_message;

        // allowFrom check
        const peerId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;
        if (account.allowFrom && account.allowFrom.length > 0) {
          if (!account.allowFrom.some((pattern) => peerId === pattern || pattern === "*")) {
            log?.debug?.(`[onebot:${account.accountId}] Ignoring message from unlisted ${peerId}`);
            return;
          }
        }

        // Skip own messages
        if (event.user_id === event.self_id) return;

        if (isGroup && account.groupRequireMention !== false && !isMentioningSelf(event)) {
          log?.debug?.(`[onebot:${account.accountId}] Ignoring group message without @ mention from group:${event.group_id}`);
          return;
        }

        log?.info(
          `[onebot:${account.accountId}] ${isGroup ? "Group" : "Private"} message from ${senderName}(${senderId}) msg=${event.message_id}: ${text.slice(0, 100)}`,
        );

        if (isGroup && account.groupAutoReact) {
          void reactToMessage(account, event.message_id, account.groupAutoReactEmojiId)
            .then((result) => {
              if (!result.ok) {
                log?.error(
                  `[onebot:${account.accountId}] Auto reaction failed for group:${event.group_id} msg=${event.message_id}: ${result.error ?? "unknown error"}`,
                );
              }
            })
            .catch((err) => {
              log?.error(
                `[onebot:${account.accountId}] Auto reaction error for group:${event.group_id} msg=${event.message_id}: ${String(err)}`,
              );
            });
        }

        const hasReply = event.message.some((seg) => seg.type === "reply");
        const hasFile = event.message.some((seg) => seg.type === "file");
        const replyContextsPromise = hasReply
          ? loadRepliedMessageContexts(account, event, log)
          : Promise.resolve<RepliedMessageContext[]>([]);
        const fileAttachmentsPromise = hasFile
          ? loadFileAttachments(account, event, log)
          : Promise.resolve<OneBotFileAttachment[]>([]);
        const [replyContexts, fileAttachments] = await Promise.all([replyContextsPromise, fileAttachmentsPromise]);
        const imageAttachments = [
          ...extractImageAttachments(event.message),
          ...replyContexts.flatMap((context) => context.imageAttachments),
        ];
        const combinedFileAttachments = [
          ...fileAttachments,
          ...replyContexts.flatMap((context) => context.fileAttachments),
        ];
        const replyContextText = replyContexts.map((context) => context.text).filter((text): text is string => Boolean(text));
        const images = imageAttachments.map((attachment) => attachment.source);
        const videos = extractVideos(event.message);
        const recordSegments = extractRecordSegments(event.message);

        // Batch key: per-chat + per-sender for groups
        const batchKey = isGroup
          ? `group:${event.group_id}::${senderId}`
          : `private:${senderId}`;

        const buffered: BufferedMessage = {
          event,
          text,
          replyContextText,
          images,
          imageAttachments,
          fileAttachments: combinedFileAttachments,
          videos,
          recordSegments,
          receivedAt,
        };

        const existing = chatBatches.get(batchKey);
        if (existing) {
          // Check limits
          if (
            existing.messages.length >= BATCH_MAX_MESSAGES ||
            existing.totalChars + text.length > BATCH_MAX_CHARS
          ) {
            // Flush current batch immediately, then start new one
            clearTimeout(existing.timer);
            chatBatches.delete(batchKey);
            dispatchMessages(batchKey, existing.messages).catch((err) =>
              log?.error(`[onebot:${account.accountId}] Batch dispatch error: ${err}`),
            );
            // Start fresh batch with this message
            const timer = setTimeout(() => {
              const batch = chatBatches.get(batchKey);
              if (batch) {
                chatBatches.delete(batchKey);
                dispatchMessages(batchKey, batch.messages).catch((err) =>
                  log?.error(`[onebot:${account.accountId}] Batch dispatch error: ${err}`),
                );
              }
            }, BATCH_GAP_MS);
            chatBatches.set(batchKey, {
              messages: [buffered],
              timer,
              totalChars: text.length,
            });
          } else {
            // Append to existing batch and reset timer
            existing.messages.push(buffered);
            existing.totalChars += text.length;
            clearTimeout(existing.timer);
            existing.timer = setTimeout(() => {
              const batch = chatBatches.get(batchKey);
              if (batch) {
                chatBatches.delete(batchKey);
                dispatchMessages(batchKey, batch.messages).catch((err) =>
                  log?.error(`[onebot:${account.accountId}] Batch dispatch error: ${err}`),
                );
              }
            }, BATCH_GAP_MS);
          }
        } else {
          // New batch
          const timer = setTimeout(() => {
            const batch = chatBatches.get(batchKey);
            if (batch) {
              chatBatches.delete(batchKey);
              dispatchMessages(batchKey, batch.messages).catch((err) =>
                log?.error(`[onebot:${account.accountId}] Batch dispatch error: ${err}`),
              );
            }
          }, BATCH_GAP_MS);
          chatBatches.set(batchKey, {
            messages: [buffered],
            timer,
            totalChars: text.length,
          });
        }
      };

      ws.on("open", () => {
        log?.info(`[onebot:${account.accountId}] WebSocket connected`);
        isConnecting = false;
        reconnectAttempts = 0;
        onReady?.({});
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const event = JSON.parse(rawData) as OneBotEvent;

          log?.debug?.(`[onebot:${account.accountId}] Event: post_type=${event.post_type}`);

          switch (event.post_type) {
            case "meta_event":
              if (event.meta_event_type === "lifecycle" && event.sub_type === "connect") {
                log?.info(`[onebot:${account.accountId}] Lifecycle: connected`);
              }
              break;

            case "message":
              bufferMessage(event as OneBotMessageEvent).catch((err) => {
                log?.error(`[onebot:${account.accountId}] Message buffer error: ${err}`);
              });
              break;

            case "notice":
              log?.debug?.(`[onebot:${account.accountId}] Notice: ${(event as { notice_type?: string }).notice_type}`);
              break;
          }
        } catch (err) {
          log?.error(`[onebot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[onebot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false;
        cleanup();

        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[onebot:${account.accountId}] WebSocket error: ${err.message}`);
        isConnecting = false;
        onError?.(err);
      });
    } catch (err) {
      isConnecting = false;
      log?.error(`[onebot:${account.accountId}] Connection failed: ${err}`);
      scheduleReconnect();
    }
  };

  // Start connection
  await connect();

  // Wait for abort signal
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
