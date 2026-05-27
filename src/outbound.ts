import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ResolvedOneBotAccount, OneBotApiResponse, OneBotMessageSegment } from './types.js';
import { getDefaultContainerSharedDir, getDefaultSharedDir } from './env.js';

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedOneBotAccount;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

export type OneBotReactionResult = {
  channel: 'onebot';
  messageId: string | number;
  emojiId: string | number;
  ok: boolean;
  error?: string;
};

export type OneBotTarget = { type: 'private' | 'group'; id: number };

const STAGED_MEDIA_DIR = 'openclaw';
const STAGED_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function parseTarget(to: string): OneBotTarget {
  const normalized = to.replace(/^onebot:/i, '');

  if (normalized.startsWith('private:')) {
    return { type: 'private', id: Number(normalized.slice(8)) };
  }
  if (normalized.startsWith('group:')) {
    return { type: 'group', id: Number(normalized.slice(6)) };
  }
  return { type: 'private', id: Number(normalized) };
}

export async function callOneBotApi(
  account: ResolvedOneBotAccount,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<OneBotApiResponse> {
  const url = `${account.httpUrl}/${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`OneBot API ${endpoint} error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as OneBotApiResponse;
}

export function ensureApiSuccess(result: OneBotApiResponse, endpoint: string): OneBotApiResponse {
  if (result.retcode !== 0 || result.status === 'failed') {
    throw new Error(
      `OneBot API ${endpoint} failed: ${result.retcode} ${result.message ?? result.wording ?? ''}`.trim(),
    );
  }
  return result;
}

function normalizeMessageRef(value: string | number): string | number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function stripFileScheme(filePath: string): string {
  return filePath.replace(/^file:\/\//i, '');
}

function toFileUri(filePath: string): string {
  return filePath.startsWith('file://') ? filePath : `file://${filePath}`;
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function isWithinDir(parentDir: string, candidatePath: string): boolean {
  const rel = relative(parentDir, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function getSharedConfig(account: ResolvedOneBotAccount): { sharedDir: string; containerSharedDir: string } {
  const raw = account.config as Record<string, unknown>;
  const sharedDir = typeof raw.sharedDir === 'string' && raw.sharedDir.trim()
    ? raw.sharedDir
    : getDefaultSharedDir();
  const containerSharedDir = typeof raw.containerSharedDir === 'string' && raw.containerSharedDir.trim()
    ? raw.containerSharedDir.replace(/\/+$/, '') || '/shared'
    : getDefaultContainerSharedDir();
  return { sharedDir, containerSharedDir };
}

async function pruneStagedMedia(rootDir: string): Promise<void> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const cutoff = Date.now() - STAGED_MEDIA_MAX_AGE_MS;
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          await pruneStagedMedia(entryPath);
          return;
        }
        const info = await stat(entryPath);
        if (info.mtimeMs < cutoff) {
          await rm(entryPath, { force: true });
        }
      }),
    );
  } catch {
    // Best-effort cleanup only.
  }
}

async function resolveNapCatMediaUri(
  account: ResolvedOneBotAccount,
  filePath: string,
  kind: 'audio' | 'images' | 'files',
): Promise<string> {
  const normalizedPath = stripFileScheme(filePath);
  const { sharedDir, containerSharedDir } = getSharedConfig(account);

  if (normalizedPath.startsWith(`${containerSharedDir}/`) || normalizedPath === containerSharedDir) {
    return toFileUri(normalizedPath);
  }

  if (!isAbsolute(normalizedPath)) {
    return toFileUri(filePath);
  }

  try {
    await stat(normalizedPath);
  } catch {
    return toFileUri(filePath);
  }

  if (isWithinDir(sharedDir, normalizedPath)) {
    const rel = toPosixPath(relative(sharedDir, normalizedPath));
    return toFileUri(posix.join(containerSharedDir, rel));
  }

  const stagedDir = join(sharedDir, STAGED_MEDIA_DIR, kind);
  await mkdir(stagedDir, { recursive: true });
  await chmod(stagedDir, 0o700).catch(() => {});

  const ext = extname(normalizedPath);
  const base = basename(normalizedPath, ext)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'media';
  const stagedName = `${Date.now()}-${randomUUID()}-${base}${ext || ''}`;
  const stagedPath = join(stagedDir, stagedName);
  await copyFile(normalizedPath, stagedPath);
  await chmod(stagedPath, 0o600).catch(() => {});

  void pruneStagedMedia(join(sharedDir, STAGED_MEDIA_DIR));

  const rel = toPosixPath(relative(sharedDir, stagedPath));
  return toFileUri(posix.join(containerSharedDir, rel));
}

function buildMessage(text: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];

  if (text.trim()) {
    segments.push({ type: 'text', data: { text } });
  }

  return segments;
}

function resolveSendMsgTarget(target: OneBotTarget): Record<string, unknown> {
  return target.type === 'private'
    ? { message_type: 'private', user_id: target.id }
    : { message_type: 'group', group_id: target.id };
}

function getResponseMessageId(result: OneBotApiResponse): string | undefined {
  const data = result.data as { message_id?: number | string } | null;
  return data?.message_id != null ? String(data.message_id) : undefined;
}

export async function sendMessageSegments(
  account: ResolvedOneBotAccount,
  target: OneBotTarget,
  message: OneBotMessageSegment[],
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'send_msg', {
    ...resolveSendMsgTarget(target),
    message,
  }), 'send_msg');
}

export async function deleteMessage(
  account: ResolvedOneBotAccount,
  messageId: string | number,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'delete_msg', {
    message_id: normalizeMessageRef(messageId),
  }), 'delete_msg');
}

export async function getMessage(
  account: ResolvedOneBotAccount,
  messageId: string | number,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_msg', {
    message_id: normalizeMessageRef(messageId),
  }), 'get_msg');
}

export async function getStatus(account: ResolvedOneBotAccount): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_status', {}), 'get_status');
}

export async function getLoginInfo(account: ResolvedOneBotAccount): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_login_info', {}), 'get_login_info');
}

export async function getFriendList(account: ResolvedOneBotAccount): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_friend_list', {}), 'get_friend_list');
}

export async function getGroupList(account: ResolvedOneBotAccount): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_group_list', {}), 'get_group_list');
}

export async function getGroupInfo(
  account: ResolvedOneBotAccount,
  groupId: string | number,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_group_info', {
    group_id: normalizeMessageRef(groupId),
  }), 'get_group_info');
}

export async function getGroupMemberInfo(
  account: ResolvedOneBotAccount,
  groupId: string | number,
  userId: string | number,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_group_member_info', {
    group_id: normalizeMessageRef(groupId),
    user_id: normalizeMessageRef(userId),
    no_cache: false,
  }), 'get_group_member_info');
}

export async function getGroupMemberList(
  account: ResolvedOneBotAccount,
  groupId: string | number,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'get_group_member_list', {
    group_id: normalizeMessageRef(groupId),
  }), 'get_group_member_list');
}

export async function setGroupBan(
  account: ResolvedOneBotAccount,
  groupId: string | number,
  userId: string | number,
  durationSeconds: string | number,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'set_group_ban', {
    group_id: normalizeMessageRef(groupId),
    user_id: normalizeMessageRef(userId),
    duration: normalizeMessageRef(durationSeconds),
  }), 'set_group_ban');
}

export async function setGroupKick(
  account: ResolvedOneBotAccount,
  groupId: string | number,
  userId: string | number,
  rejectAddRequest = false,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'set_group_kick', {
    group_id: normalizeMessageRef(groupId),
    user_id: normalizeMessageRef(userId),
    reject_add_request: rejectAddRequest,
  }), 'set_group_kick');
}

export async function setGroupLeave(
  account: ResolvedOneBotAccount,
  groupId: string | number,
  isDismiss = false,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'set_group_leave', {
    group_id: normalizeMessageRef(groupId),
    is_dismiss: isDismiss,
  }), 'set_group_leave');
}

export async function sendLike(
  account: ResolvedOneBotAccount,
  userId: string | number,
  times: string | number = 1,
): Promise<OneBotApiResponse> {
  return ensureApiSuccess(await callOneBotApi(account, 'send_like', {
    user_id: normalizeMessageRef(userId),
    times: normalizeMessageRef(times),
  }), 'send_like');
}

export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, text, account } = ctx;

  if (!account.httpUrl) {
    return { channel: 'onebot', error: 'OneBot not configured (missing httpUrl)' };
  }

  try {
    const target = parseTarget(to);
    const message = buildMessage(text);

    let result: OneBotApiResponse;

    if (target.type === 'private') {
      result = await callOneBotApi(account, 'send_private_msg', {
        user_id: target.id,
        message,
      });
    } else {
      result = await callOneBotApi(account, 'send_group_msg', {
        group_id: target.id,
        message,
      });
    }

    if (result.retcode !== 0) {
      return {
        channel: 'onebot',
        error: `OneBot API returned error: ${result.retcode} ${result.message ?? result.wording ?? ''}`,
      };
    }

    return {
      channel: 'onebot',
      messageId: getResponseMessageId(result),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: 'onebot', error: message };
  }
}

export async function sendImage(
  account: ResolvedOneBotAccount,
  targetType: 'private' | 'group',
  targetId: number,
  filePath: string,
): Promise<OneBotApiResponse> {
  const mediaUri = await resolveNapCatMediaUri(account, filePath, 'images');
  const message: OneBotMessageSegment[] = [
    { type: 'image', data: { file: mediaUri } },
  ];

  const endpoint = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
  const idField = targetType === 'private' ? 'user_id' : 'group_id';

  return ensureApiSuccess(await callOneBotApi(account, endpoint, { [idField]: targetId, message }), endpoint);
}

export async function sendRecord(
  account: ResolvedOneBotAccount,
  targetType: 'private' | 'group',
  targetId: number,
  filePath: string,
): Promise<OneBotApiResponse> {
  const mediaUri = await resolveNapCatMediaUri(account, filePath, 'audio');
  const message: OneBotMessageSegment[] = [
    { type: 'record', data: { file: mediaUri } },
  ];

  const endpoint = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
  const idField = targetType === 'private' ? 'user_id' : 'group_id';

  return ensureApiSuccess(await callOneBotApi(account, endpoint, { [idField]: targetId, message }), endpoint);
}

export async function uploadFile(
  account: ResolvedOneBotAccount,
  targetType: 'private' | 'group',
  targetId: number,
  filePath: string,
  fileName: string,
): Promise<OneBotApiResponse> {
  const mediaUri = await resolveNapCatMediaUri(account, filePath, 'files');
  const endpoint = targetType === 'private' ? 'upload_private_file' : 'upload_group_file';
  const idField = targetType === 'private' ? 'user_id' : 'group_id';

  return ensureApiSuccess(await callOneBotApi(account, endpoint, {
    [idField]: targetId,
    file: mediaUri,
    name: fileName,
  }), endpoint);
}

export async function reactToMessage(
  account: ResolvedOneBotAccount,
  messageId: string | number,
  emojiId: string | number,
): Promise<OneBotReactionResult> {
  if (!account.httpUrl) {
    return {
      channel: 'onebot',
      messageId,
      emojiId,
      ok: false,
      error: 'OneBot not configured (missing httpUrl)',
    };
  }

  try {
    const result = await callOneBotApi(account, 'set_msg_emoji_like', {
      message_id: normalizeMessageRef(messageId),
      emoji_id: normalizeMessageRef(emojiId),
    });

    if (result.retcode !== 0) {
      return {
        channel: 'onebot',
        messageId,
        emojiId,
        ok: false,
        error: `OneBot API returned error: ${result.retcode} ${result.message ?? result.wording ?? ''}`.trim(),
      };
    }

    return {
      channel: 'onebot',
      messageId,
      emojiId,
      ok: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel: 'onebot',
      messageId,
      emojiId,
      ok: false,
      error: message,
    };
  }
}
