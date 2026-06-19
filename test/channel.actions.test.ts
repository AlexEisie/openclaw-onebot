import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildImageSegment,
  buildVideoSegment,
  deleteMessage,
  getGroupInfo,
  getGroupList,
  getGroupMemberInfo,
  getGroupMemberList,
  getStatus,
  reactToMessage,
  sendLike,
  sendMessageSegments,
  sendImage,
  sendRecord,
  sendText,
  setGroupBan,
  setGroupKick,
  setGroupLeave,
  uploadFile,
} = vi.hoisted(() => ({
  buildImageSegment: vi.fn(),
  buildVideoSegment: vi.fn(),
  deleteMessage: vi.fn(),
  getGroupInfo: vi.fn(),
  getGroupList: vi.fn(),
  getGroupMemberInfo: vi.fn(),
  getGroupMemberList: vi.fn(),
  getStatus: vi.fn(),
  reactToMessage: vi.fn(),
  sendLike: vi.fn(),
  sendMessageSegments: vi.fn(),
  sendImage: vi.fn(),
  sendRecord: vi.fn(),
  sendText: vi.fn(),
  setGroupBan: vi.fn(),
  setGroupKick: vi.fn(),
  setGroupLeave: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('../src/outbound.js', () => ({
  buildImageSegment,
  buildVideoSegment,
  deleteMessage,
  getGroupInfo,
  getGroupList,
  getGroupMemberInfo,
  getGroupMemberList,
  getStatus,
  parseTarget: (to: string) => {
    const normalized = to.replace(/^onebot:/i, '');
    if (normalized.startsWith('group:')) return { type: 'group', id: Number(normalized.slice(6)) };
    if (normalized.startsWith('private:')) return { type: 'private', id: Number(normalized.slice(8)) };
    return { type: 'private', id: Number(normalized) };
  },
  reactToMessage,
  sendLike,
  sendMessageSegments,
  sendImage,
  sendRecord,
  sendText,
  setGroupBan,
  setGroupKick,
  setGroupLeave,
  uploadFile,
}));

import { onebotPlugin } from '../src/channel.js';

describe('channel actions', () => {
  beforeEach(() => {
    buildImageSegment.mockReset();
    buildVideoSegment.mockReset();
    deleteMessage.mockReset();
    getGroupInfo.mockReset();
    getGroupList.mockReset();
    getGroupMemberInfo.mockReset();
    getGroupMemberList.mockReset();
    getStatus.mockReset();
    reactToMessage.mockReset();
    sendLike.mockReset();
    sendMessageSegments.mockReset();
    sendImage.mockReset();
    sendRecord.mockReset();
    sendText.mockReset();
    setGroupBan.mockReset();
    setGroupKick.mockReset();
    setGroupLeave.mockReset();
    uploadFile.mockReset();
    buildImageSegment.mockImplementation(async (_account, source) => ({
      type: 'image',
      data: { file: String(source).startsWith('http') ? source : `file://${source}` },
    }));
    buildVideoSegment.mockImplementation(async (_account, source) => ({
      type: 'video',
      data: { file: String(source).startsWith('http') ? source : `file://${source}` },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises OneBot message actions', () => {
    expect(onebotPlugin.actions?.describeMessageTool?.({
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any)).toEqual({ actions: [
      'react',
      'reply',
      'unsend',
      'delete',
      'read',
      'member-info',
      'channel-info',
      'channel-list',
      'kick',
      'timeout',
      'leaveGroup',
      'set-profile',
    ] });
    expect(onebotPlugin.actions?.supportsAction?.({ action: 'react' } as any)).toBe(true);
    expect(onebotPlugin.actions?.supportsAction?.({ action: 'unsend' } as any)).toBe(true);
    expect(onebotPlugin.actions?.supportsAction?.({ action: 'wave' } as any)).toBe(false);
  });

  it('hides message-tool actions when the account is not configured', () => {
    expect(onebotPlugin.actions?.describeMessageTool?.({
      cfg: {},
    } as any)).toBeNull();
  });

  it('rejects unsupported actions and missing reaction params', async () => {
    const unsupported = await onebotPlugin.actions!.handleAction!({
      action: 'wave',
      cfg: {},
      params: {},
      accountId: 'default',
      toolContext: {},
    } as any);
    expect(unsupported.details).toMatchObject({ ok: false, channel: 'onebot', action: 'wave' });
    expect(String((unsupported.details as any).error)).toMatch(/Unsupported OneBot action/);

    const missing = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {},
      params: {},
      accountId: 'default',
      toolContext: {},
    } as any);
    expect(missing.details).toMatchObject({ ok: false, channel: 'onebot', action: 'react' });
    expect(String((missing.details as any).error)).toMatch(/requires `emoji` and `message_id`/);
  });

  it('forwards successful reactions and reports failures', async () => {
    reactToMessage.mockResolvedValueOnce({
      ok: true,
      messageId: '123',
      emojiId: '128077',
    });

    const success = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
      params: {
        message_id: '123',
        emoji: '128077',
      },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(success.details).toMatchObject({ ok: true, channel: 'onebot', action: 'react' });
    expect(reactToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'default' }),
      '123',
      '128077',
    );

    reactToMessage.mockResolvedValueOnce({
      ok: false,
      error: 'reaction failed',
    });

    const failure = await onebotPlugin.actions!.handleAction!({
      action: 'react',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
      params: {
        messageId: '555',
        reaction: '1',
      },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(failure.details).toMatchObject({ ok: false, channel: 'onebot', action: 'react' });
    expect(String((failure.details as any).error)).toMatch(/reaction failed/);
  });

  it('handles reply and delete style OneBot actions', async () => {
    sendMessageSegments.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 77 },
    });

    const reply = await onebotPlugin.actions!.handleAction!({
      action: 'reply',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
      params: {
        to: 'group:42',
        message_id: '11',
        text: 'roger',
      },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(reply.details).toMatchObject({ ok: true, channel: 'onebot', action: 'reply' });
    expect(sendMessageSegments).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      { type: 'group', id: 42 },
      [
        { type: 'reply', data: { id: '11' } },
        { type: 'text', data: { text: 'roger' } },
      ],
    );

    deleteMessage.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: null });

    const deleted = await onebotPlugin.actions!.handleAction!({
      action: 'unsend',
      cfg: {},
      params: { message_id: '99' },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(deleted.details).toMatchObject({ ok: true, channel: 'onebot', action: 'unsend' });
    expect(deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'default' }), '99');
  });

  it('sends reply actions with mentions and images as OneBot segments', async () => {
    sendMessageSegments.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 78 },
    });

    const reply = await onebotPlugin.actions!.handleAction!({
      action: 'reply',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
      params: {
        to: 'group:42',
        message_id: '11',
        mentions: ['10001', '10002'],
        text: 'see this',
        imageUrls: ['https://img.example/a.png'],
        mediaUrl: '/tmp/local.png',
      },
      accountId: 'default',
      toolContext: {},
    } as any);

    expect(reply.details).toMatchObject({ ok: true, channel: 'onebot', action: 'reply' });
    expect(buildImageSegment).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'https://img.example/a.png',
    );
    expect(buildImageSegment).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      '/tmp/local.png',
    );
    expect(sendMessageSegments).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      { type: 'group', id: 42 },
      [
        { type: 'reply', data: { id: '11' } },
        { type: 'at', data: { qq: '10001' } },
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text: 'see this' } },
        { type: 'image', data: { file: 'https://img.example/a.png' } },
        { type: 'image', data: { file: 'file:///tmp/local.png' } },
      ],
    );
  });

  it('handles OneBot info and group management actions', async () => {
    getStatus.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: { online: true } });
    getGroupList.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: [{ group_id: 1 }] });
    getGroupInfo.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: { group_id: 1 } });
    getGroupMemberInfo.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: { user_id: 2 } });
    setGroupBan.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: null });
    setGroupKick.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: null });
    setGroupLeave.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: null });
    sendLike.mockResolvedValueOnce({ status: 'ok', retcode: 0, data: null });

    const base = {
      cfg: {},
      accountId: 'default',
      toolContext: {},
    };

    await onebotPlugin.actions!.handleAction!({ ...base, action: 'read', params: {} } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'channel-list', params: {} } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'channel-info', params: { group_id: '1' } } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'member-info', params: { group_id: '1', user_id: '2' } } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'timeout', params: { group_id: '1', user_id: '2', duration: 60 } } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'kick', params: { group_id: '1', user_id: '2' } } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'leaveGroup', params: { group_id: '1' } } as any);
    await onebotPlugin.actions!.handleAction!({ ...base, action: 'set-profile', params: { user_id: '2', times: 2 } } as any);

    expect(getStatus).toHaveBeenCalled();
    expect(getGroupList).toHaveBeenCalled();
    expect(getGroupInfo).toHaveBeenCalledWith(expect.anything(), '1');
    expect(getGroupMemberInfo).toHaveBeenCalledWith(expect.anything(), '1', '2');
    expect(setGroupBan).toHaveBeenCalledWith(expect.anything(), '1', '2', 60);
    expect(setGroupKick).toHaveBeenCalledWith(expect.anything(), '1', '2', false);
    expect(setGroupLeave).toHaveBeenCalledWith(expect.anything(), '1', false);
    expect(sendLike).toHaveBeenCalledWith(expect.anything(), '2', 2);
  });

  it('routes outbound text through resolved OneBot accounts', async () => {
    sendText.mockResolvedValueOnce({
      channel: 'onebot',
      messageId: 'out-1',
      error: undefined,
    });

    const result = await onebotPlugin.outbound!.sendText!({
      to: 'private:42',
      text: 'hello',
      accountId: 'default',
      replyToId: 'r1',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: 'private:42',
      text: 'hello',
      replyToId: 'r1',
      account: expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
    }));
    expect(result.messageId).toBe('out-1');

    sendText.mockResolvedValueOnce({
      channel: 'onebot',
      messageId: 'out-2',
      error: 'send failed',
    });

    const failed = onebotPlugin.outbound!.sendText!({
      to: 'private:42',
      text: 'hello',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    await expect(failed).rejects.toThrow(/send failed/);
  });

  it('routes outbound image media through sendImage and sends caption text separately', async () => {
    sendImage.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 99 },
    });
    sendText.mockResolvedValueOnce({
      channel: 'onebot',
      messageId: 'caption-1',
      error: undefined,
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'onebot:private:42',
      text: 'caption',
      mediaUrl: 'file:///tmp/My%20Image.png',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendImage).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'private',
      42,
      '/tmp/My Image.png',
    );
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: 'onebot:private:42',
      text: 'caption',
      account: expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
    }));
    expect(result).toMatchObject({ channel: 'onebot', messageId: '99' });
  });

  it('routes outbound audio media through sendRecord', async () => {
    sendRecord.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 101 },
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'group:77',
      text: '',
      mediaUrl: '/tmp/reply.m4a',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'group',
      77,
      '/tmp/reply.m4a',
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ channel: 'onebot', messageId: '101' });
  });

  it('routes outbound video media through generic OneBot send_msg', async () => {
    sendMessageSegments.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: { message_id: 102 },
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'group:77',
      text: '',
      mediaUrl: '/tmp/reply.mp4',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(sendMessageSegments).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      { type: 'group', id: 77 },
      [{ type: 'video', data: { file: 'file:///tmp/reply.mp4' } }],
    );
    expect(buildVideoSegment).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      '/tmp/reply.mp4',
    );
    expect(result).toMatchObject({ channel: 'onebot', messageId: '102' });
  });

  it('routes non-image media through uploadFile using the basename', async () => {
    uploadFile.mockResolvedValueOnce({
      status: 'ok',
      retcode: 0,
      data: {},
    });

    const result = await onebotPlugin.outbound!.sendMedia!({
      to: 'private:42',
      mediaUrl: '/tmp/archive/report final.pdf',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ httpUrl: 'http://127.0.0.1:3001' }),
      'private',
      42,
      '/tmp/archive/report final.pdf',
      'report final.pdf',
    );
    expect(result.channel).toBe('onebot');
    expect(typeof result.messageId).toBe('string');
  });

  it('rejects remote media URLs for outbound sendMedia', async () => {
    const attempt = onebotPlugin.outbound!.sendMedia!({
      to: 'private:42',
      mediaUrl: 'https://example.com/file.png',
      accountId: 'default',
      cfg: {
        channels: {
          onebot: {
            wsUrl: 'ws://127.0.0.1:3000',
            httpUrl: 'http://127.0.0.1:3001',
          },
        },
      },
    } as any);

    await expect(attempt).rejects.toThrow(/local file paths only/);
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendRecord).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('builds status snapshots from runtime state', () => {
    const snapshot = onebotPlugin.status!.buildAccountSnapshot!({
      account: {
        accountId: 'default',
        name: 'QQ',
        enabled: true,
        wsUrl: 'ws://127.0.0.1:3000',
        httpUrl: 'http://127.0.0.1:3001',
      },
      runtime: {
        running: true,
        connected: true,
        lastConnectedAt: 123,
        lastError: 'none',
      },
    } as any);

    expect(snapshot).toEqual(expect.objectContaining({
      accountId: 'default',
      name: 'QQ',
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastConnectedAt: 123,
      lastError: 'none',
    }));
  });
});
