import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startMockOneBotWsServer } from './helpers/mock-ws-server.js';
import { startMockOneBotHttpServer } from './helpers/mock-http-server.js';
import { createMockRuntime } from './helpers/mock-runtime.js';

let runtimeState: any;
vi.mock('../src/runtime.js', () => {
  return {
    getOneBotRuntime: () => runtimeState.runtime,
  };
});

describe('e2e', () => {
  beforeEach(() => {
    runtimeState = createMockRuntime({ nextDeliverPayload: { text: 'e2e-reply' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('private message -> dispatch -> outbound HTTP send_private_msg', async () => {
    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
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
      message_id: 2001,
      user_id: 3001,
      message: [{ type: 'text', data: { text: 'hello e2e' } }],
      raw_message: 'hello e2e',
      sender: { user_id: 3001, nickname: 'E2EUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(httpServer.requests.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const req = httpServer.requests[0];
    expect(req.url).toBe('/send_private_msg');
    expect(req.bodyJson.user_id).toBe(3001);
    expect(req.bodyJson.message[0].type).toBe('text');
    expect(req.bodyJson.message[0].data.text).toBe('e2e-reply');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('group message -> outbound HTTP send_group_msg', async () => {
    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
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
      message_id: 2002,
      user_id: 3002,
      group_id: 4002,
      message: [
        { type: 'at', data: { qq: 999 } },
        { type: 'text', data: { text: 'hey group' } },
      ],
      raw_message: 'hey group',
      sender: { user_id: 3002, nickname: 'GroupUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(httpServer.requests.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const req = httpServer.requests[0];
    expect(req.url).toBe('/send_group_msg');
    expect(req.bodyJson.group_id).toBe(4002);

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('media reply: deliver mediaUrls triggers image send + text send', async () => {
    runtimeState = createMockRuntime({
      nextDeliverPayload: { text: 'here', mediaUrls: ['/tmp/pic.png'] },
    });

    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();
    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
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
      message_id: 2003,
      user_id: 3003,
      message: [{ type: 'text', data: { text: 'need image' } }],
      raw_message: 'need image',
      sender: { user_id: 3003, nickname: 'MediaUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => expect(httpServer.requests.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

    const [r1, r2] = httpServer.requests;
    expect(r1.url).toBe('/send_private_msg');
    expect(r1.bodyJson.message[0].type).toBe('image');
    expect(String(r1.bodyJson.message[0].data.file)).toContain('file:///tmp/pic.png');

    expect(r2.url).toBe('/send_private_msg');
    expect(r2.bodyJson.message[0].type).toBe('text');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('loads context from the OneBot message being replied to', async () => {
    const httpServer = await startMockOneBotHttpServer({
      handler: (req) => {
        if (req.url === '/get_msg') {
          return {
            status: 'ok',
            retcode: 0,
            data: {
              message_id: 9001,
              sender: { user_id: 3005, nickname: 'OriginalUser' },
              message: [
                { type: 'text', data: { text: 'original message without bot mention' } },
                { type: 'image', data: { url: 'https://img.example/replied.png', summary: 'photo' } },
              ],
            },
          };
        }
        return undefined;
      },
    });
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();
    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
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
      message_id: 2004,
      user_id: 3004,
      group_id: 4004,
      message: [
        { type: 'reply', data: { id: 9001 } },
        { type: 'at', data: { qq: 999 } },
        { type: 'text', data: { text: 'can you see it?' } },
      ],
      raw_message: '[CQ:reply,id=9001][CQ:at,qq=999] can you see it?',
      sender: { user_id: 3004, nickname: 'ReplyImageUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(runtimeState.state.lastEnvelopeArgs).not.toBeNull();
    }, { timeout: 5000 });

    expect(httpServer.requests.some((req) => req.url === '/get_msg')).toBe(true);
    expect(runtimeState.state.lastEnvelopeArgs.body).toContain('[replied message 9001 from OriginalUser]: original message without bot mention');
    expect(runtimeState.state.lastEnvelopeArgs.body).toContain('can you see it?');
    expect(runtimeState.state.lastEnvelopeArgs.imageUrls).toEqual(['https://img.example/replied.png']);
    expect(runtimeState.state.lastEnvelopeArgs.imageAttachments).toEqual([
      {
        source: 'https://img.example/replied.png',
        url: 'https://img.example/replied.png',
        summary: 'photo',
      },
    ]);
    expect(runtimeState.state.lastDispatchArgs.ctx.MediaUrl).toBe('https://img.example/replied.png');
    expect(runtimeState.state.lastDispatchArgs.ctx.MediaUrls).toBeUndefined();
    expect(runtimeState.state.lastDispatchArgs.ctx.mediaUrl).toBe('https://img.example/replied.png');
    expect(runtimeState.state.lastDispatchArgs.ctx.mediaUrls).toBeUndefined();
    expect(runtimeState.state.lastDispatchArgs.ctx.MediaPath).toBeUndefined();
    expect(runtimeState.state.lastDispatchArgs.ctx.mediaPath).toBeUndefined();
    expect(runtimeState.state.lastDispatchArgs.ctx.mediaType).toBe('image/png');
    expect(runtimeState.state.lastDispatchArgs.ctx.mediaTypes).toEqual(['image/png']);
    expect(runtimeState.state.lastDispatchArgs.ctx.BodyForAgent).toContain('[replied message 9001 from OriginalUser]: original message without bot mention');
    expect(runtimeState.state.lastDispatchArgs.ctx.BodyForAgent).toContain('can you see it?');
    expect(runtimeState.state.lastDispatchArgs.ctx.BodyForAgent).toContain('[Image attached photo]');
    expect(runtimeState.state.lastDispatchArgs.ctx.BodyForAgent).not.toContain('https://img.example/replied.png');
    expect(runtimeState.state.lastEnvelopeArgs.body).toContain('[Image: https://img.example/replied.png photo]');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('block streaming sends multiple QQ messages in order', async () => {
    runtimeState = createMockRuntime({
      nextDeliverPayloads: [
        { text: 'stream-1' },
        { text: 'stream-2' },
      ],
    });

    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');

    const ac = new AbortController();

    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => (readyResolve = r));

    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
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
      message_id: 2004,
      user_id: 3004,
      message: [{ type: 'text', data: { text: 'stream it' } }],
      raw_message: 'stream it',
      sender: { user_id: 3004, nickname: 'StreamUser' },
      self_id: 999,
      time: Math.floor(Date.now() / 1000),
    });

    await vi.waitFor(() => {
      expect(httpServer.requests.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });

    expect(httpServer.requests[0].url).toBe('/send_private_msg');
    expect(httpServer.requests[0].bodyJson.message[0].data.text).toBe('stream-1');
    expect(httpServer.requests[1].bodyJson.message[0].data.text).toBe('stream-2');

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });

  it('reconnects after WS close and can reconnect to restarted server', async () => {
    const httpServer = await startMockOneBotHttpServer();
    const wsServer = await startMockOneBotWsServer();

    const { startGateway } = await import('../src/gateway.js');
    const ac = new AbortController();

    let readyCount = 0;
    const runP = startGateway({
      account: {
        accountId: 'default',
        enabled: true,
        wsUrl: wsServer.wsUrl,
        httpUrl: httpServer.baseUrl,
        config: {},
      },
      abortSignal: ac.signal,
      cfg: {},
      onReady: () => {
        readyCount++;
      },
      log: { info: () => {}, error: () => {}, debug: () => {} },
    });

    await vi.waitFor(() => expect(readyCount).toBe(1));

    wsServer.closeAllClients(4002, 'boom');

    // Wait for reconnect delay (>=1s)
    await new Promise((r) => setTimeout(r, 1200));

    expect(wsServer.connectionUrls.length).toBeGreaterThanOrEqual(2);

    ac.abort();
    await runP;
    await wsServer.close();
    await httpServer.close();
  });
});
