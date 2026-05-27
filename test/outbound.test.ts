import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildImageSegment,
  deleteMessage,
  getGroupFileUrl,
  getGroupInfo,
  getGroupMemberInfo,
  getPrivateFileUrl,
  getStatus,
  sendLike,
  sendMessageSegments,
  sendText,
  sendImage,
  sendRecord,
  setGroupBan,
  setGroupKick,
  uploadFile,
  reactToMessage,
} from '../src/outbound.js';
import type { ResolvedOneBotAccount } from '../src/types.js';

function mkAccount(overrides?: Partial<ResolvedOneBotAccount>): ResolvedOneBotAccount {
  return {
    accountId: 'default',
    enabled: true,
    wsUrl: 'ws://x',
    httpUrl: 'http://127.0.0.1:1',
    config: {},
    ...overrides,
  } as any;
}

describe('outbound', () => {
  const oldFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
  });

  it('sendText: defaults raw number target to private', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9 } }),
    });

    const res = await sendText({ to: '123', text: 'hi', account: mkAccount() });
    expect(res.error).toBeUndefined();

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(123);
    expect(body.message[0].type).toBe('text');
  });

  it('sendText: private target uses send_private_msg', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }),
    });

    await sendText({ to: 'private:123', text: 'hello', account: mkAccount() });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(123);
  });

  it('sendText: group target uses send_group_msg', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 2 } }),
    });

    await sendText({ to: 'onebot:group:456', text: 'yo', account: mkAccount() });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_group_msg$/);
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(456);
  });

  it('sendText: handles API retcode failures', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'failed', retcode: 100, data: null, message: 'bad' }),
    });

    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount() });
    expect(res.error).toMatch(/returned error/);
  });

  it('sendText: handles non-200 response', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Oops',
      json: async () => ({}),
    });

    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount() });
    expect(res.error).toMatch(/500/);
  });

  it('sendText: handles network error', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('net down'));
    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount() });
    expect(res.error).toMatch(/net down/);
  });

  it('sendText: missing httpUrl returns error', async () => {
    const res = await sendText({ to: 'private:1', text: 'x', account: mkAccount({ httpUrl: '' }) });
    expect(res.error).toMatch(/missing httpUrl/);
  });

  it('sendImage: preserves direct file uri for non-staged paths', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 3 } }),
    });

    await sendImage(mkAccount(), 'private', 1, '/tmp/a.png');
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(1);
    expect(body.message[0].type).toBe('image');
    expect(body.message[0].data.file).toBe('file:///tmp/a.png');
  });

  it('sendRecord: sends record segment', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 4 } }),
    });

    await sendRecord(mkAccount(), 'group', 9, 'file:///tmp/a.mp3');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_group_msg$/);
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(9);
    expect(body.message[0].type).toBe('record');
  });

  it('sendRecord: stages absolute host files into the container shared dir', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 4 } }),
    });

    const root = mkdtempSync(join(tmpdir(), 'onebot-record-'));
    const sharedDir = join(root, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const source = join(root, 'voice.mp3');
    writeFileSync(source, 'voice-bytes');

    await sendRecord(
      mkAccount({ config: { sharedDir, containerSharedDir: '/shared' } as any }),
      'private',
      9,
      source,
    );

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.message[0].data.file).toMatch(/^file:\/\/\/shared\/openclaw\/audio\//);

    const rel = body.message[0].data.file.replace('file:///shared/', '');
    const staged = join(sharedDir, rel);
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged, 'utf8')).toBe('voice-bytes');
    if (process.platform !== 'win32') {
      expect(statSync(staged).mode & 0o777).toBe(0o600);
      expect(statSync(join(sharedDir, 'openclaw', 'audio')).mode & 0o777).toBe(0o700);
    }
  });

  it('buildImageSegment: keeps remote image URLs and stages local files when needed', async () => {
    expect(await buildImageSegment(mkAccount(), 'https://img.example/a.png')).toEqual({
      type: 'image',
      data: { file: 'https://img.example/a.png' },
    });

    const root = mkdtempSync(join(tmpdir(), 'onebot-image-segment-'));
    const sharedDir = join(root, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const source = join(root, 'picture.png');
    writeFileSync(source, 'image-bytes');

    const segment = await buildImageSegment(
      mkAccount({ config: { sharedDir, containerSharedDir: '/shared' } as any }),
      source,
    );

    expect(segment.type).toBe('image');
    expect(String(segment.data.file)).toMatch(/^file:\/\/\/shared\/openclaw\/images\//);
    const rel = String(segment.data.file).replace('file:///shared/', '');
    expect(readFileSync(join(sharedDir, rel), 'utf8')).toBe('image-bytes');
  });

  it('uploadFile: calls upload_group_file with file uri', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: {} }),
    });

    await uploadFile(mkAccount(), 'group', 9, '/tmp/f.zip', 'f.zip');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/upload_group_file$/);
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(9);
    expect(body.file).toBe('file:///tmp/f.zip');
    expect(body.name).toBe('f.zip');
  });

  it('sendMessageSegments: uses generic send_msg for private and group targets', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 55 } }),
    });

    await sendMessageSegments(mkAccount(), { type: 'group', id: 123 }, [
      { type: 'reply', data: { id: '44' } },
      { type: 'text', data: { text: 'hello' } },
    ]);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_msg$/);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ message_type: 'group', group_id: 123 });
    expect(body.message).toEqual([
      { type: 'reply', data: { id: '44' } },
      { type: 'text', data: { text: 'hello' } },
    ]);
  });

  it('wraps common OneBot v11 management APIs', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: {} }),
    });

    await deleteMessage(mkAccount(), '100');
    await getStatus(mkAccount());
    await getGroupInfo(mkAccount(), '200');
    await getGroupMemberInfo(mkAccount(), '200', '300');
    await setGroupBan(mkAccount(), '200', '300', 60);
    await setGroupKick(mkAccount(), '200', '300', true);
    await sendLike(mkAccount(), '300', 2);

    const endpoints = (globalThis.fetch as any).mock.calls.map(([url]: any[]) => String(url).split('/').pop());
    expect(endpoints).toEqual([
      'delete_msg',
      'get_status',
      'get_group_info',
      'get_group_member_info',
      'set_group_ban',
      'set_group_kick',
      'send_like',
    ]);

    const kickBody = JSON.parse((globalThis.fetch as any).mock.calls[5][1].body);
    expect(kickBody).toMatchObject({ group_id: 200, user_id: 300, reject_add_request: true });
  });

  it('sendText: includes Authorization header when accessToken is set', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 10 } }),
    });

    await sendText({ to: 'private:1', text: 'x', account: mkAccount({ accessToken: 'AT' }) });
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer AT');
  });

  it('sendImage: group target preserves relative file path', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 3 } }) });
    await sendImage(mkAccount(), 'group', 1, 'a.png');
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.group_id).toBe(1);
    expect(body.message[0].type).toBe('image');
    expect(body.message[0].data.file).toBe('file://a.png');
  });

  it('sendRecord: private target works without file prefix', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 4 } }) });
    await sendRecord(mkAccount(), 'private', 9, 'a.mp3');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/send_private_msg$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(9);
    expect(body.message[0].type).toBe('record');
    expect(body.message[0].data.file).toBe('file://a.mp3');
  });

  it('uploadFile: calls upload_private_file with file uri', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) });
    await uploadFile(mkAccount(), 'private', 9, '/tmp/f.zip', 'f.zip');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/upload_private_file$/);
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe(9);
    expect(body.file).toBe('file:///tmp/f.zip');
  });

  it('reactToMessage: calls set_msg_emoji_like', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: null }),
    });

    const res = await reactToMessage(mkAccount(), '5566', '128077');
    expect(res.ok).toBe(true);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/set_msg_emoji_like$/);
    const body = JSON.parse(init.body);
    expect(body.message_id).toBe(5566);
    expect(body.emoji_id).toBe(128077);
  });

  it('file URL helpers call NapCat file APIs', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', retcode: 0, data: { url: 'https://file.local/x.txt' } }),
    });

    await getPrivateFileUrl(mkAccount(), 'private-file-id');
    await getGroupFileUrl(mkAccount(), '123', 'group-file-id', '456');

    const privateCall = (globalThis.fetch as any).mock.calls[0];
    expect(String(privateCall[0])).toMatch(/get_private_file_url$/);
    expect(JSON.parse(privateCall[1].body)).toEqual({ file_id: 'private-file-id' });

    const groupCall = (globalThis.fetch as any).mock.calls[1];
    expect(String(groupCall[0])).toMatch(/get_group_file_url$/);
    expect(JSON.parse(groupCall[1].body)).toEqual({ group_id: 123, file_id: 'group-file-id', busid: 456 });
  });

  it('reactToMessage: surfaces API errors', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'failed', retcode: 100, data: null, message: 'bad react' }),
    });

    const res = await reactToMessage(mkAccount(), 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/bad react/);
  });

  it('reactToMessage: returns config errors when httpUrl is missing', async () => {
    const res = await reactToMessage(mkAccount({ httpUrl: '' }), '55', '66');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing httpUrl/);
  });

  it('reactToMessage: returns thrown network errors', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('reaction network down'));
    const res = await reactToMessage(mkAccount(), '55', '66');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reaction network down/);
  });
});
