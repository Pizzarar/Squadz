import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CALL_MEMBER_EVENT_TYPE } from '../src/matrixrtc.js';
import { BYTES_PER_FRAME } from '../src/audio.js';
import { SoundboardBot } from '../src/bot.js';
import { loadConfigFromEnv } from '../src/index.js';

const BUNDLED_CLIPS_DIR = fileURLToPath(new URL('../clips', import.meta.url));

function createHarness({ roomState = [], idleTimeoutMs = 60_000 } = {}) {
  const notices = [];
  const joinedRooms = [];
  const memberStates = [];
  const capturedFrames = [];
  let sfuRequests = 0;

  const mockMatrix = {
    userId: '@soundboard:chat.squadz.test',
    deviceId: 'SBDEV01',
    joinRoom: async (roomId) => {
      joinedRooms.push(roomId);
    },
    sendNotice: async (roomId, text) => {
      notices.push({ roomId, text });
    },
    getRoomState: async () => roomState,
    requestOpenIdToken: async () => ({
      access_token: 'openid_tok',
      token_type: 'Bearer',
      matrix_server_name: 'chat.squadz.test',
    }),
    putCallMemberState: async (roomId, content) => {
      memberStates.push({ roomId, content });
    },
  };

  const mockFetch = async (url) => {
    if (url === 'https://rtc.squadz.test/livekit/jwt/sfu/get') {
      sfuRequests++;
      return new Response(
        JSON.stringify({
          url: 'wss://rtc.squadz.test/livekit/sfu',
          jwt: 'lk_jwt_token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const mockRtcFactory = async () => ({
    createRoom: () => ({
      connect: async () => {},
      disconnect: async () => {},
      localParticipant: { publishTrack: async () => ({ sid: 'TR_1' }) },
    }),
    createAudioSource: () => ({
      captureFrame: async (f) => {
        capturedFrames.push(f);
      },
      waitForPlayout: async () => {},
      clearQueue: () => {},
      close: async () => {},
    }),
    createAudioTrack: () => ({ close: async () => {} }),
    createAudioFrame: (data, sampleRate, channels, samplesPerChannel) => ({
      data,
      sampleRate,
      channels,
      samplesPerChannel,
    }),
    createPublishOptions: () => ({}),
  });

  const bot = new SoundboardBot({
    matrix: mockMatrix,
    rtcFqdn: 'rtc.squadz.test',
    clipsDir: BUNDLED_CLIPS_DIR,
    idleTimeoutMs,
    decodeClip: async () => Buffer.alloc(BYTES_PER_FRAME * 2),
    rtcFactory: mockRtcFactory,
    fetchImpl: mockFetch,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return {
    bot,
    notices,
    joinedRooms,
    memberStates,
    capturedFrames,
    getSfuRequests: () => sfuRequests,
  };
}

describe('SoundboardBot end-to-end orchestration', () => {
  it('auto-joins invited rooms and responds to !sb list', async () => {
    const { bot, joinedRooms, notices } = createHarness();

    await bot.handleSyncResponse({
      rooms: {
        invite: { '!lounge:chat.squadz.test': {} },
        join: {
          '!lounge:chat.squadz.test': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@alice:chat.squadz.test',
                  content: { msgtype: 'm.text', body: '!sb list' },
                },
              ],
            },
          },
        },
      },
    });

    assert.deepEqual(joinedRooms, ['!lounge:chat.squadz.test']);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /Available clips.*beep/);
  });

  it('refuses to join LiveKit when !sb play is run in a room with no active MatrixRTC call', async () => {
    const { bot, notices, memberStates, getSfuRequests } = createHarness({ roomState: [] });

    await bot.handleCommand('!lounge:chat.squadz.test', { action: 'play', clip: 'beep' });

    assert.equal(getSfuRequests(), 0);
    assert.equal(memberStates.length, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /No active voice call/);
  });

  it('joins active call on !sb play, publishes PCM frames, and clears call.member state on leave', async () => {
    const activeCallState = [
      {
        type: CALL_MEMBER_EVENT_TYPE,
        sender: '@alice:chat.squadz.test',
        state_key: '_@alice:chat.squadz.test_DEV1_m.call',
        content: {
          application: 'm.call',
          call_id: '',
          scope: 'm.room',
          device_id: 'DEV1',
          created_ts: Date.now() - 2000,
          expires: 3600_000,
          foci_preferred: [
            {
              type: 'livekit',
              livekit_service_url: 'https://rtc.squadz.test/livekit/jwt',
              livekit_alias: '!lounge:chat.squadz.test',
            },
          ],
        },
      },
    ];

    const { bot, notices, memberStates, capturedFrames, getSfuRequests } = createHarness({
      roomState: activeCallState,
      idleTimeoutMs: 60_000,
    });

    await bot.handleCommand('!lounge:chat.squadz.test', { action: 'play', clip: 'beep' });

    assert.equal(getSfuRequests(), 1);
    assert.equal(memberStates.length, 1);
    assert.equal(memberStates[0].content.application, 'm.call');
    assert.equal(memberStates[0].content.device_id, 'SBDEV01');
    assert.equal(capturedFrames.length, 2);

    // Handle !sb stop while session is active
    await bot.handleCommand('!lounge:chat.squadz.test', { action: 'stop' });
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /Stopped playback/);

    // Shutdown clears the call.member state event with `{}`
    await bot.shutdown();
    assert.equal(memberStates.length, 2);
    assert.deepEqual(memberStates[1].content, {});
  });

  it('validates contract environment variables in loadConfigFromEnv', () => {
    assert.throws(() => loadConfigFromEnv({}), /Missing required environment variables/);

    const cfg = loadConfigFromEnv({
      CHAT_FQDN: 'chat.squadz.test',
      RTC_FQDN: 'rtc.squadz.test',
      SOUNDBOARD_MATRIX_USER: 'soundboard',
      SOUNDBOARD_MATRIX_PASSWORD: 'secret',
    });
    assert.equal(cfg.clipsDir, '/clips');
    assert.equal(cfg.chatFqdn, 'chat.squadz.test');
    assert.equal(cfg.rtcFqdn, 'rtc.squadz.test');
  });
});
