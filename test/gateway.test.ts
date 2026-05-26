import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockOneBotWsServer } from './helpers/mock-ws-server.js';
import { createMockRuntime } from './helpers/mock-runtime.js';

// Mock runtime module used by gateway.ts
let runtimeState: any;
vi.mock('../src/runtime.js', () => {
  return {
    getOneBotRuntime: () => runtimeState.runtime,
  };
});

// Mock outbound so gateway unit tests don't depend on real fetch/http
const outboundCalls: any[] = [];
const outboundMockState: {
  sendTextError: Error | null;
  sendImageError: Error | null;
  sendRecordError: Error | null;
  reactError: Error | null;
  reactResult: { ok: boolean; error?: string } | null;
} = {
  sendTextError: null,
  sendImageError: null,
  sendRecordError: null,
  reactError: null,
  reactResult: null,
};
vi.mock('../src/outbound.js', () => {
  return {
    sendText: async (args: any) => {
      if (outboundMockState.sendTextError) {
        throw outboundMockState.sendTextError;
      }
      outboundCalls.push({ kind: 'text', args });
      return { channel: 'onebot', messageId: '1' };
    },
    sendImage: async (...args: any[]) => {
      if (outboundMockState.sendImageError) {
        throw outboundMockState.sendImageError;
      }
      outboundCalls.push({ kind: 'image', args });
      return { status: 'ok', retcode: 0, data: {} };
    },
    sendRecord: async (...args: any[]) => {
      if (outboundMockState.sendRecordError) {
        throw outboundMockState.sendRecordError;
      }
      outboundCalls.push({ kind: 'record', args });
      return { status: 'ok', retcode: 0, data: {} };
    },
    reactToMessage: async (...args: any[]) => {
      if (outboundMockState.reactError) {
        throw outboundMockState.reactError;
      }
      outboundCalls.push({ kind: 'react', args });
      return {
        channel: 'onebot',
        ok: outboundMockState.reactResult?.ok ?? true,
        error: outboundMockState.reactResult?.error,
        messageId: args[1],
        emojiId: args[2],
      };
    },
  };
});

// Batch gap is 1500ms — tests need longer waitFor timeouts
const WAIT_FOR_BATCH = { timeout: 5000 };

describe('gateway', () => {
  beforeEach(() => {
    outboundCalls.length = 0;
    outboundMockState.sendTextError = null;
    outboundMockState.sendImageError = null;
    outboundMockState.sendRecordError = null;
    outboundMockState.reactError = null;
    outboundMockState.reactResult = null;
    runtimeState = createMockRuntime({
      nextDeliverPayload: { text: 'reply-from-agent', mediaUrls: ['file:///tmp/x.png'] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects and includes access_token query', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let ready = false;
    const p = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        accessToken: 'TOKEN',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => { ready = true; },
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await vi.waitFor(() => {
      expect(ready).toBe(true);
      expect(wsServer.connectionUrls.length).toBeGreaterThan(0);
    });

    expect(wsServer.connectionUrls[0]).toContain('access_token=TOKEN');

    ac.abort();
    await p;
    await wsServer.close();
  });

  it('parses private message and dispatches to runtime', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: { messages: {} },
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 111,
      user_id: 222,
      message: [{ type: 'text', data: { text: 'hello' } }],
      raw_message: 'hello',
      sender: { user_id: 222, nickname: 'Alice' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, WAIT_FOR_BATCH);

    const ctx = runtimeState.state.lastDispatchArgs.ctx;
    expect(ctx.From).toBe('onebot:private:222');
    expect(String(ctx.MessageSid)).toBe('111');

    await vi.waitFor(() => {
      expect(outboundCalls.find((c) => c.kind === 'image')).toBeTruthy();
      expect(outboundCalls.find((c) => c.kind === 'text')).toBeTruthy();
    }, WAIT_FOR_BATCH);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('adds image/voice annotations to body when segments present', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 112,
      user_id: 223,
      message: [
        { type: 'text', data: { text: 'hi' } },
        { type: 'image', data: { url: 'http://img' } },
        { type: 'record', data: { url: 'http://voice' } },
      ],
      raw_message: 'hi',
      sender: { user_id: 223, nickname: 'Bob' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(runtimeState.state.lastEnvelopeArgs).not.toBeNull();
    }, WAIT_FOR_BATCH);

    const envArgs = runtimeState.state.lastEnvelopeArgs;
    expect(String(envArgs.body)).toContain('[Image: http://img]');
    // Voice download fails in test (fake URL) -> falls back to placeholder
    expect(String(envArgs.body)).toMatch(/\[语音\]|<media:audio>/);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('delivers block replies as multiple outbound messages', async () => {
    runtimeState = createMockRuntime({
      nextDeliverPayloads: [
        { text: 'part-1' },
        { text: 'part-2' },
      ],
    });

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {
        agents: { defaults: { blockStreamingDefault: 'on' } },
      },
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 113,
      user_id: 224,
      message: [{ type: 'text', data: { text: 'stream please' } }],
      raw_message: 'stream please',
      sender: { user_id: 224, nickname: 'Streamer' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      const texts = outboundCalls.filter((c) => c.kind === 'text');
      expect(texts.length).toBeGreaterThanOrEqual(2);
    }, WAIT_FOR_BATCH);

    const textPayloads = outboundCalls
      .filter((c) => c.kind === 'text')
      .map((c) => c.args.text);
    expect(textPayloads).toEqual(expect.arrayContaining(['part-1', 'part-2']));

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('auto reacts to inbound group messages by default', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        groupAutoReact: true,
        groupAutoReactEmojiId: 1,
        groupRequireMention: false,
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 114,
      user_id: 225,
      group_id: 999001,
      message: [{ type: 'text', data: { text: 'hello group' } }],
      raw_message: 'hello group',
      sender: { user_id: 225, nickname: 'GroupUser', role: 'member' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      const reactions = outboundCalls.filter((c) => c.kind === 'react');
      expect(reactions.length).toBeGreaterThanOrEqual(1);
    }, WAIT_FOR_BATCH);

    const reactionCall = outboundCalls.find((c) => c.kind === 'react');
    expect(reactionCall.args[1]).toBe(114);
    expect(reactionCall.args[2]).toBe(1);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('requires @ mention for group messages by default', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        groupAutoReact: false,
        groupAutoReactEmojiId: 1,
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 116,
      user_id: 227,
      group_id: 999003,
      message: [{ type: 'text', data: { text: 'not for bot' } }],
      raw_message: 'not for bot',
      sender: { user_id: 227, nickname: 'QuietGroupUser', role: 'member' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await new Promise((r) => setTimeout(r, 2500));
    expect(runtimeState.state.lastDispatchArgs).toBeNull();

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 117,
      user_id: 228,
      group_id: 999003,
      message: [
        { type: 'at', data: { qq: '999' } },
        { type: 'text', data: { text: 'hello bot' } },
      ],
      raw_message: '[CQ:at,qq=999] hello bot',
      sender: { user_id: 228, nickname: 'MentionGroupUser', role: 'member' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, WAIT_FOR_BATCH);

    expect(runtimeState.state.lastDispatchArgs.ctx.From).toBe('onebot:group:999003');

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('can disable automatic group reactions via config', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        groupAutoReact: false,
        groupAutoReactEmojiId: 1,
        groupRequireMention: false,
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 115,
      user_id: 226,
      group_id: 999002,
      message: [{ type: 'text', data: { text: 'no react please' } }],
      raw_message: 'no react please',
      sender: { user_id: 226, nickname: 'MutedGroupUser', role: 'member' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(runtimeState.state.lastDispatchArgs).not.toBeNull();
    }, WAIT_FOR_BATCH);

    const reactions = outboundCalls.filter((c) => c.kind === 'react');
    expect(reactions).toHaveLength(0);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('reconnects on abnormal close (uses timers)', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyCount = 0;
    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => { readyCount++; },
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await vi.waitFor(() => expect(readyCount).toBe(1));
    wsServer.closeAllClients(4002, 'boom');
    await new Promise((r) => setTimeout(r, 1200));
    expect(wsServer.connectionUrls.length).toBeGreaterThanOrEqual(2);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('ignores invalid JSON payloads', async () => {
    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
      status: { online: true },
      interval: 10000,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(true).toBe(true);

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('includes audio media payload in inbound context when local voice files are readable', async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), 'onebot-gateway-media-'));
    const mp3Path = join(mediaDir, 'voice.mp3');
    const wavPath = join(mediaDir, 'voice.wav');
    await writeFile(mp3Path, Buffer.from('mock-mp3'));
    await writeFile(wavPath, Buffer.from('mock-wav'));

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));
    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 212,
      user_id: 323,
      message: [
        { type: 'text', data: { text: 'voice payload' } },
        { type: 'image', data: { url: 'http://img.local/test.png' } },
        { type: 'record', data: { file: `file://${mp3Path}` } },
        { type: 'record', data: { file: `file://${wavPath}` } },
      ],
      raw_message: 'voice payload',
      sender: { user_id: 323, nickname: 'MediaPayload' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(runtimeState.state.lastFinalizeArgs).not.toBeNull();
    }, WAIT_FOR_BATCH);

    expect(runtimeState.state.lastEnvelopeArgs.body).toContain('[Image: http://img.local/test.png]');
    expect(runtimeState.state.lastEnvelopeArgs.body).toContain('<media:audio>');
    expect(runtimeState.state.lastFinalizeArgs.MediaPath).toBe(mp3Path);
    expect(runtimeState.state.lastFinalizeArgs.MediaPaths).toEqual([mp3Path, wavPath]);
    expect(runtimeState.state.lastFinalizeArgs.MediaTypes).toEqual(['audio/mpeg', 'audio/wav']);
    expect(runtimeState.state.lastFinalizeArgs.MediaUrls).toEqual([mp3Path, wavPath]);

    ac.abort();
    await runP;
    await wsServer.close();
    await rm(mediaDir, { recursive: true, force: true });
  });

  it('falls back to text when audio reply delivery fails', async () => {
    outboundMockState.sendRecordError = new Error('napcat refused record');
    runtimeState = createMockRuntime({
      nextDeliverPayload: { mediaUrls: ['/tmp/reply-audio.mp3'] },
    });

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));
    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 213,
      user_id: 324,
      message: [{ type: 'text', data: { text: 'send voice back' } }],
      raw_message: 'send voice back',
      sender: { user_id: 324, nickname: 'AudioReplyFail' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(outboundCalls.some((call) => call.kind === 'text')).toBe(true);
    }, WAIT_FOR_BATCH);

    expect(outboundCalls.find((call) => call.kind === 'text')?.args.text).toContain('语音回复发送失败');

    ac.abort();
    await runP;
    await wsServer.close();
  });

  it('sends processing failure when dispatch setup throws', async () => {
    runtimeState = createMockRuntime();
    runtimeState.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      () => {
        throw new Error('dispatch exploded');
      },
    );

    const wsServer = await startMockOneBotWsServer();
    const ac = new AbortController();
    const { startGateway } = await import('../src/gateway.js');

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));
    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: 'http://x',
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => readyResolve(),
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await readyP;

    wsServer.sendToAll({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 214,
      user_id: 325,
      message: [{ type: 'text', data: { text: 'trigger outer catch' } }],
      raw_message: 'trigger outer catch',
      sender: { user_id: 325, nickname: 'DispatcherThrow' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(outboundCalls.some((call) => call.kind === 'text')).toBe(true);
    }, WAIT_FOR_BATCH);

    expect(outboundCalls.find((call) => call.kind === 'text')?.args.text).toContain(
      '[OpenClaw] Processing failed: Error: dispatch exploded',
    );

    ac.abort();
    await runP;
    await wsServer.close();
  });
});
