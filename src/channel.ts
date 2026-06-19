import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount, OneBotMessageSegment } from "./types.js";
import { getDefaultContainerSharedDir, getDefaultSharedDir } from "./env.js";
import { listOneBotAccountIds, resolveOneBotAccount, applyOneBotAccountConfig } from "./config.js";
import {
  buildImageSegment,
  buildVideoSegment,
  deleteMessage,
  getFriendList,
  getGroupInfo,
  getGroupList,
  getGroupMemberInfo,
  getGroupMemberList,
  getLoginInfo,
  getMessage,
  getStatus,
  parseTarget,
  reactToMessage,
  sendImage,
  sendLike,
  sendMessageSegments,
  sendRecord,
  sendText,
  setGroupBan,
  setGroupKick,
  setGroupLeave,
  uploadFile,
} from "./outbound.js";
import { startGateway } from "./gateway.js";

const DEFAULT_ACCOUNT_ID = "default";
const ONEBOT_MESSAGE_ACTIONS = [
  "react",
  "reply",
  "unsend",
  "delete",
  "read",
  "member-info",
  "channel-info",
  "channel-list",
  "kick",
  "timeout",
  "leaveGroup",
  "set-profile",
] as const;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".amr", ".silk", ".opus"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

function createActionResult<TDetails>(text: string, details: TDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function resolveLocalMediaPath(mediaUrl: string): string {
  if (!mediaUrl || !mediaUrl.trim()) {
    throw new Error("OneBot sendMedia requires mediaUrl");
  }
  if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
    throw new Error("OneBot sendMedia currently supports local file paths only");
  }
  if (mediaUrl.startsWith("file://")) {
    try {
      return fileURLToPath(mediaUrl);
    } catch {
      return decodeURIComponent(new URL(mediaUrl).pathname);
    }
  }
  return isAbsolute(mediaUrl) ? mediaUrl : resolvePath(mediaUrl);
}

function readStringParam(params: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = params[name];
    if (value != null && String(value).trim() !== "") return String(value);
  }
  return undefined;
}

function readNumberParam(params: Record<string, unknown>, names: string[]): number | undefined {
  const value = readStringParam(params, names);
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBooleanParam(params: Record<string, unknown>, names: string[], fallback = false): boolean {
  const value = readStringParam(params, names);
  if (value == null) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function buildTextSegments(text?: string): OneBotMessageSegment[] {
  const trimmed = text ?? "";
  return trimmed ? [{ type: "text", data: { text: trimmed } }] : [];
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function readMentionParams(params: Record<string, unknown>): string[] {
  const mentions = [
    ...toArray(params.at),
    ...toArray(params.mention),
    ...toArray(params.mentions),
    ...toArray(params.at_user_id),
    ...toArray(params.atUserId),
    ...toArray(params.at_user_ids),
    ...toArray(params.atUserIds),
    ...toArray(params.mention_user_id),
    ...toArray(params.mentionUserId),
    ...toArray(params.mention_user_ids),
    ...toArray(params.mentionUserIds),
  ]
    .map((value) => String(value).trim())
    .filter(Boolean);

  return [...new Set(mentions)];
}

function readImageParams(params: Record<string, unknown>): string[] {
  const images = [
    ...toArray(params.image),
    ...toArray(params.images),
    ...toArray(params.image_url),
    ...toArray(params.imageUrl),
    ...toArray(params.image_urls),
    ...toArray(params.imageUrls),
    ...toArray(params.mediaUrl),
    ...toArray(params.mediaUrls),
  ]
    .map((value) => String(value).trim())
    .filter(Boolean);

  return [...new Set(images)];
}

async function buildReplySegments(
  account: ResolvedOneBotAccount,
  params: Record<string, unknown>,
): Promise<OneBotMessageSegment[]> {
  const messageId = readStringParam(params, ["message_id", "messageId", "reply_to", "replyTo"]);
  const text = readStringParam(params, ["text", "body", "message"]);
  const segments: OneBotMessageSegment[] = [];
  if (messageId) segments.push({ type: "reply", data: { id: messageId } });
  for (const qq of readMentionParams(params)) {
    segments.push({ type: "at", data: { qq } });
  }
  segments.push(...buildTextSegments(text));
  for (const image of readImageParams(params)) {
    segments.push(await buildImageSegment(account, image));
  }
  return segments;
}

function oneBotDataResult(text: string, action: string, data: unknown) {
  return createActionResult(text, {
    ok: true,
    channel: "onebot",
    action,
    data,
  });
}

export const onebotPlugin: ChannelPlugin<ResolvedOneBotAccount> = {
  id: "onebot",
  meta: {
    id: "onebot",
    label: "OneBot",
    selectionLabel: "OneBot (QQ via NapCat)",
    docsPath: "/docs/channels/onebot",
    blurb: "Connect to QQ via OneBot 11 protocol (NapCat/go-cqhttp)",
    order: 55,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    reply: true,
    unsend: true,
    groupManagement: true,
    threads: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 80,
      idleMs: 600,
    },
  },
  reload: { configPrefixes: ["channels.onebot"] },
  messaging: {
    normalizeTarget: (target) => {
      return target.replace(/^onebot:/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const normalized = id.replace(/^onebot:/i, "");
        if (normalized.startsWith("private:")) return /^private:\d+$/.test(normalized);
        if (normalized.startsWith("group:")) return /^group:\d+$/.test(normalized);
        return /^\d+$/.test(normalized);
      },
      hint: "private:<user_id> or group:<group_id>",
    },
  },
  config: {
    listAccountIds: (cfg) => listOneBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOneBotAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account?.wsUrl && account?.httpUrl),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl && account?.httpUrl),
    }),
  },
  setup: {
    validateInput: ({ input }) => {
      if (!input.token && !input.useEnv) {
        return "OneBot requires --token (format: wsUrl,httpUrl[,accessToken[,sharedDir[,containerSharedDir]]]) or --use-env (ONEBOT_WS_URL, ONEBOT_HTTP_URL)";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let wsUrl = "";
      let httpUrl = "";
      let accessToken: string | undefined;
      const raw = input as Record<string, unknown>;
      let sharedDir = typeof raw.sharedDir === "string" && raw.sharedDir.trim()
        ? raw.sharedDir.trim()
        : undefined;
      let containerSharedDir = typeof raw.containerSharedDir === "string" && raw.containerSharedDir.trim()
        ? raw.containerSharedDir.trim()
        : undefined;

      if (input.token) {
        const parts = input.token.split(",");
        wsUrl = parts[0]?.trim() ?? "";
        httpUrl = parts[1]?.trim() ?? "";
        accessToken = parts[2]?.trim() || undefined;
        sharedDir ??= parts[3]?.trim() || undefined;
        containerSharedDir ??= parts[4]?.trim() || undefined;
      }

      if (!input.useEnv) {
        sharedDir ??= getDefaultSharedDir();
        containerSharedDir ??= getDefaultContainerSharedDir();
      }

      return applyOneBotAccountConfig(cfg, accountId, {
        wsUrl,
        httpUrl,
        accessToken,
        sharedDir,
        containerSharedDir,
        name: input.name,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4500,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveOneBotAccount(cfg, accountId);
      const result = await sendText({ to, text, accountId, replyToId, account });
      if (result.error) {
        throw new Error(result.error);
      }
      if (!result.messageId) {
        throw new Error("OneBot sendText did not return a messageId");
      }
      return {
        channel: "onebot",
        messageId: result.messageId,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, forceDocument }) => {
      const account = resolveOneBotAccount(cfg, accountId);
      const target = parseTarget(to);
      const mediaPath = resolveLocalMediaPath(mediaUrl ?? "");
      const ext = extname(mediaPath).toLowerCase();

      let mediaResult;
      if (forceDocument) {
        mediaResult = await uploadFile(account, target.type, target.id, mediaPath, basename(mediaPath));
      } else if (AUDIO_EXTS.has(ext)) {
        mediaResult = await sendRecord(account, target.type, target.id, mediaPath);
      } else if (IMAGE_EXTS.has(ext)) {
        mediaResult = await sendImage(account, target.type, target.id, mediaPath);
      } else if (VIDEO_EXTS.has(ext)) {
        mediaResult = await sendMessageSegments(account, target, [
          await buildVideoSegment(account, mediaPath),
        ]);
      } else {
        mediaResult = await uploadFile(account, target.type, target.id, mediaPath, basename(mediaPath));
      }

      let textMessageId: string | undefined;
      if ((text ?? "").trim()) {
        const textResult = await sendText({ to, text, accountId, account });
        if (textResult.error) {
          throw new Error(textResult.error);
        }
        textMessageId = textResult.messageId;
      }

      const mediaMessageId =
        mediaResult?.data && typeof mediaResult.data === "object" && "message_id" in mediaResult.data
          ? String(mediaResult.data.message_id)
          : undefined;

      return {
        channel: "onebot",
        messageId: mediaMessageId ?? textMessageId ?? `${Date.now()}`,
      };
    },
  },
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = resolveOneBotAccount(cfg);
      if (!account.enabled || !account.wsUrl || !account.httpUrl) {
        return null;
      }
      return {
        actions: [...ONEBOT_MESSAGE_ACTIONS],
      };
    },
    supportsAction: ({ action }) => (ONEBOT_MESSAGE_ACTIONS as readonly string[]).includes(action),
    handleAction: async ({ action, cfg, params, accountId, toolContext }) => {
      if (!(ONEBOT_MESSAGE_ACTIONS as readonly string[]).includes(action)) {
        return createActionResult(`Unsupported OneBot action: ${action}`, {
          ok: false,
          channel: "onebot",
          action,
          error: `Unsupported OneBot action: ${action}`,
        });
      }

      const account = resolveOneBotAccount(cfg, accountId);

      const messageId =
        params.message_id ??
        params.messageId ??
        params.message ??
        toolContext?.currentMessageId;

      if (action === "reply") {
        const to = readStringParam(params, ["to", "target"]) ?? toolContext?.currentChannelId;
        const segments = await buildReplySegments(account, params);
        if (!to || segments.length === 0) {
          return createActionResult("OneBot reply requires `to` and at least one of reply text, message_id, mention, or image.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot reply requires `to` and at least one of reply text, message_id, mention, or image.",
          });
        }
        const result = await sendMessageSegments(account, parseTarget(to), segments);
        return oneBotDataResult("OneBot reply sent.", action, result);
      }

      if (action === "unsend" || action === "delete") {
        if (messageId == null) {
          return createActionResult("OneBot delete requires `message_id` or current message context.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot delete requires `message_id` or current message context.",
          });
        }
        const result = await deleteMessage(account, messageId as string | number);
        return oneBotDataResult(`Deleted OneBot message ${String(messageId)}.`, action, result);
      }

      if (action === "read") {
        if (messageId != null) {
          const result = await getMessage(account, messageId as string | number);
          return oneBotDataResult(`Fetched OneBot message ${String(messageId)}.`, action, result);
        }
        const query = readStringParam(params, ["query", "kind", "type"]) ?? "status";
        const result = query === "login" ? await getLoginInfo(account) : await getStatus(account);
        return oneBotDataResult(`Fetched OneBot ${query}.`, action, result);
      }

      if (action === "channel-list") {
        const kind = readStringParam(params, ["kind", "type"]) ?? "groups";
        const result = kind === "friends" ? await getFriendList(account) : await getGroupList(account);
        return oneBotDataResult(`Fetched OneBot ${kind}.`, action, result);
      }

      if (action === "channel-info") {
        const groupId = readStringParam(params, ["group_id", "groupId", "channel_id", "channelId"]);
        if (!groupId) {
          return createActionResult("OneBot channel-info requires `group_id`.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot channel-info requires `group_id`.",
          });
        }
        const result = await getGroupInfo(account, groupId);
        return oneBotDataResult(`Fetched OneBot group ${groupId}.`, action, result);
      }

      if (action === "member-info") {
        const groupId = readStringParam(params, ["group_id", "groupId"]);
        const userId = readStringParam(params, ["user_id", "userId", "member_id", "memberId"]);
        if (!groupId) {
          return createActionResult("OneBot member-info requires `group_id`.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot member-info requires `group_id`.",
          });
        }
        const result = userId
          ? await getGroupMemberInfo(account, groupId, userId)
          : await getGroupMemberList(account, groupId);
        return oneBotDataResult(`Fetched OneBot group member data for ${groupId}.`, action, result);
      }

      if (action === "kick") {
        const groupId = readStringParam(params, ["group_id", "groupId"]);
        const userId = readStringParam(params, ["user_id", "userId", "member_id", "memberId"]);
        if (!groupId || !userId) {
          return createActionResult("OneBot kick requires `group_id` and `user_id`.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot kick requires `group_id` and `user_id`.",
          });
        }
        const result = await setGroupKick(account, groupId, userId, readBooleanParam(params, ["reject_add_request", "rejectAddRequest"]));
        return oneBotDataResult(`Kicked OneBot group member ${userId}.`, action, result);
      }

      if (action === "timeout") {
        const groupId = readStringParam(params, ["group_id", "groupId"]);
        const userId = readStringParam(params, ["user_id", "userId", "member_id", "memberId"]);
        const duration = readNumberParam(params, ["duration", "duration_seconds", "durationSeconds", "seconds"]) ?? 1800;
        if (!groupId || !userId) {
          return createActionResult("OneBot timeout requires `group_id` and `user_id`.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot timeout requires `group_id` and `user_id`.",
          });
        }
        const result = await setGroupBan(account, groupId, userId, duration);
        return oneBotDataResult(`Muted OneBot group member ${userId}.`, action, result);
      }

      if (action === "leaveGroup") {
        const groupId = readStringParam(params, ["group_id", "groupId"]);
        if (!groupId) {
          return createActionResult("OneBot leaveGroup requires `group_id`.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot leaveGroup requires `group_id`.",
          });
        }
        const result = await setGroupLeave(account, groupId, readBooleanParam(params, ["is_dismiss", "isDismiss"]));
        return oneBotDataResult(`Left OneBot group ${groupId}.`, action, result);
      }

      if (action === "set-profile") {
        const userId = readStringParam(params, ["user_id", "userId", "target", "to"]);
        const times = readNumberParam(params, ["times", "count"]) ?? 1;
        if (!userId) {
          return createActionResult("OneBot set-profile currently supports `send_like` and requires `user_id`.", {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot set-profile currently supports `send_like` and requires `user_id`.",
          });
        }
        const result = await sendLike(account, userId, times);
        return oneBotDataResult(`Sent OneBot like to ${userId}.`, action, result);
      }

      const emojiId =
        params.emoji_id ??
        params.emojiId ??
        params.emoji ??
        params.reaction;

      if (messageId == null || emojiId == null || String(emojiId).trim() === "") {
        return createActionResult(
          "OneBot react requires `emoji` and `message_id` (or current message context).",
          {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot react requires `emoji` and `message_id` (or current message context).",
          },
        );
      }

      const result = await reactToMessage(account, messageId as string | number, emojiId as string | number);

      if (!result.ok) {
        return createActionResult(result.error ?? "OneBot reaction failed", {
          ok: false,
          channel: "onebot",
          action,
          error: result.error ?? "OneBot reaction failed",
          data: result,
        });
      }

      return createActionResult(`Reacted with ${String(emojiId)} to message ${String(messageId)}.`, {
        ok: true,
        channel: "onebot",
        action,
        data: result,
      });
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[onebot:${account.accountId}] Starting gateway`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[onebot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[onebot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl && account?.httpUrl),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
};
