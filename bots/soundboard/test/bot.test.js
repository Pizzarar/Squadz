import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CALL_MEMBER_EVENT_TYPE } from '../src/matrixrtc.js';
import { BYTES_PER_FRAME, abortError } from '../src/audio.js';
import { SoundboardBot } from '../src/bot.js';
import { loadConfigFromEnv } from '../src/index.js';

const BUNDLED_CLIPS_DIR = fileURLToPath(new URL('../clips', import.meta.url));
const CLIPS = '!clips:chat.squadz.test';
const SPACE = '!space:chat.squadz.test';
const LOUNGE = '!lounge:chat.squadz.test';
const GAME = '!game:chat.squadz.test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function callMember(deviceId, alias) {
  return {
    type: CALL_MEMBER_EVENT_TYPE,
    sender: '@alice:chat.squadz.test',
    state_key: `_@alice:chat.squadz.test_${deviceId}_m.call`,
    content: {
      application: 'm.call',
      call_id: '',
      scope: 'm.room',
      device_id: deviceId,
      created_ts: Date.now() - 2000,
      expires: 3600_000,
      foci_preferred: [
        {
          type: 'livekit',
          livekit_service_url: 'https://rtc.squadz.test/livekit/jwt',
          livekit_alias: alias,
        },
      ],
    },
  };
}
const nameEv = (name) => ({ type: 'm.room.name', state_key: '', content: { name } });

function createHarness({ activeRooms = [LOUNGE], idleTimeoutMs = 60_000, decodeClip, memberExpiresMs } = {}) {
  const notices = [];
  const joinedRooms = [];
  const memberStates = [];
  const capturedFrames = [];
  const sfuBodies = [];
  const rtcRooms = [];

  const state = {
    [CLIPS]: [
      { type: 'm.space.parent', state_key: SPACE, content: { via: ['chat.squadz.test'] } },
      nameEv('clips'),
    ],
    [SPACE]: [
      { type: 'm.space.child', state_key: CLIPS, content: { via: ['chat.squadz.test'] } },
      { type: 'm.space.child', state_key: LOUNGE, content: { via: ['chat.squadz.test'] } },
      { type: 'm.space.child', state_key: GAME, content: { via: ['chat.squadz.test'] } },
    ],
    [LOUNGE]: [
      nameEv('Lounge'),
      { type: 'm.room.canonical_alias', state_key: '', content: { alias: '#lounge:chat.squadz.test' } },
    ],
    [GAME]: [nameEv('Game Night')],
  };
  // livekit_alias deliberately differs from the room ID to prove the bot ignores it for /sfu/get.
  for (const id of activeRooms) state[id].push(callMember('DEV1', 'some-other-alias'));

  const mockMatrix = {
    userId: '@soundboard:chat.squadz.test',
    deviceId: 'SBDEV01',
    joinRoom: async (roomId) => joinedRooms.push(roomId),
    sendNotice: async (roomId, text) => notices.push({ roomId, text }),
    getRoomState: async (roomId) => state[roomId] ?? [],
    resolveAlias: async (alias) => {
      assert.equal(alias, '#clips:chat.squadz.test');
      return CLIPS;
    },
    requestOpenIdToken: async () => ({ access_token: 'openid_tok' }),
    putCallMemberState: async (roomId, content) => memberStates.push({ roomId, content }),
  };

  const mockFetch = async (url, init) => {
    if (url === 'https://rtc.squadz.test/livekit/jwt/sfu/get') {
      sfuBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ url: 'wss://rtc.squadz.test/livekit/sfu', jwt: 'lk_jwt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  const mockRtcFactory = async () => {
    const room = Object.assign(new EventEmitter(), {
      connect: async () => {},
      disconnect: async () => {},
      localParticipant: { publishTrack: async () => ({ sid: 'TR_1' }) },
    });
    rtcRooms.push(room);
    return {
      createRoom: () => room,
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
    };
  };

  const bot = new SoundboardBot({
    matrix: mockMatrix,
    rtcFqdn: 'rtc.squadz.test',
    clipsDir: BUNDLED_CLIPS_DIR,
    commandRoomAlias: '#clips:chat.squadz.test',
    idleTimeoutMs,
    memberExpiresMs,
    decodeClip: decodeClip ?? (async () => Buffer.alloc(BYTES_PER_FRAME * 2)),
    rtcFactory: mockRtcFactory,
    fetchImpl: mockFetch,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { bot, notices, joinedRooms, memberStates, capturedFrames, sfuBodies, rtcRooms };
}

const syncWith = (roomId, body, sender = '@alice:chat.squadz.test', type = 'm.room.message') => ({
  rooms: {
    join: {
      [roomId]: { timeline: { events: [{ type, sender, content: { msgtype: 'm.text', body } }] } },
    },
  },
});

/** A decode stub that blocks until aborted (or released), recording the signal it received. */
function blockingDecoder() {
  const calls = [];
  const decodeClip = (file, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const call = { signal, release: () => resolve(Buffer.alloc(BYTES_PER_FRAME * 2)) };
      calls.push(call);
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  return { decodeClip, calls };
}

describe('SoundboardBot command source (#clips only)', () => {
  it('auto-joins invites and answers !sb list in #clips', async () => {
    const { bot, joinedRooms, notices } = createHarness();
    await bot.handleSyncResponse({
      rooms: { invite: { [LOUNGE]: {} }, ...syncWith(CLIPS, '!sb list').rooms },
    });
    assert.deepEqual(joinedRooms, [LOUNGE]);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].roomId, CLIPS);
    assert.match(notices[0].text, /Available clips.*beep/);
  });

  it('ignores commands from other rooms, encrypted events and its own messages', async () => {
    const { bot, notices } = createHarness();
    await bot.handleSyncResponse(syncWith(LOUNGE, '!sb list'));
    await bot.handleSyncResponse(syncWith(CLIPS, '!sb list', '@alice:chat.squadz.test', 'm.room.encrypted'));
    await bot.handleSyncResponse(syncWith(CLIPS, '!sb list', '@soundboard:chat.squadz.test'));
    assert.equal(notices.length, 0);
  });
});

describe('SoundboardBot voice-room resolution', () => {
  it('plays in the single active call and sends the Matrix roomId (not livekit_alias) to /sfu/get', async () => {
    const { bot, memberStates, capturedFrames, sfuBodies } = createHarness({ activeRooms: [LOUNGE] });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await bot.whenIdle();
    assert.equal(sfuBodies.length, 1);
    assert.equal(sfuBodies[0].room, LOUNGE);
    assert.equal(sfuBodies[0].device_id, 'SBDEV01');
    assert.equal(memberStates[0].roomId, LOUNGE);
    assert.equal(memberStates[0].content.foci_preferred[0].livekit_alias, LOUNGE);
    assert.equal(capturedFrames.length, 2);
    await bot.shutdown();
    assert.deepEqual(memberStates.at(-1).content, {});
  });

  it('asks which room when several calls are active, and honours `in <room>` by name or alias', async () => {
    const { bot, notices, sfuBodies } = createHarness({ activeRooms: [LOUNGE, GAME] });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    assert.match(notices[0].text, /Which room\?/);
    assert.match(notices[0].text, /Lounge/);
    assert.match(notices[0].text, /Game Night/);
    assert.equal(sfuBodies.length, 0);

    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep', room: 'game night' });
    await bot.whenIdle();
    assert.equal(sfuBodies.at(-1).room, GAME);

    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep', room: '#lounge:chat.squadz.test' });
    await bot.whenIdle();
    assert.equal(sfuBodies.at(-1).room, LOUNGE);
    await bot.shutdown();
  });

  it('reports no active call, unknown room, and explicit room without a call', async () => {
    const { bot, notices, sfuBodies } = createHarness({ activeRooms: [] });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    assert.match(notices.at(-1).text, /No active voice call in any room/);
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep', room: 'nowhere' });
    assert.match(notices.at(-1).text, /No voice room matches "nowhere"/);
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep', room: 'lounge' });
    assert.match(notices.at(-1).text, /No active voice call in "lounge"/);
    assert.equal(sfuBodies.length, 0);
  });
});

describe('SoundboardBot playback concurrency', () => {
  it('does not block the /sync loop while a clip is playing, so !sb stop is processed', async () => {
    const { decodeClip, calls } = blockingDecoder();
    const { bot, notices } = createHarness({ decodeClip });

    // If handleSyncResponse awaited playback, this would never resolve (decoder is blocked).
    await bot.handleSyncResponse(syncWith(CLIPS, '!sb play beep'));
    assert.equal(calls.length, 1);
    assert.equal(bot.playbacks.size, 1);

    await bot.handleSyncResponse(syncWith(CLIPS, '!sb stop'));
    assert.equal(calls[0].signal.aborted, true);
    assert.match(notices.at(-1).text, /Stopped playback/);
    await bot.whenIdle();
    assert.equal(bot.playbacks.size, 0);
    await bot.handleCommand(CLIPS, { action: 'stop' });
    assert.match(notices.at(-1).text, /Nothing is playing/);
  });

  it('keeps one active playback per voice room: a new play preempts the old one', async () => {
    const { decodeClip, calls } = blockingDecoder();
    const { bot } = createHarness({ decodeClip });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await tick();
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls.length, 2); // second starts only after the first unwound
    assert.equal(calls[1].signal.aborted, false);
    assert.equal(bot.playbacks.size, 1);
    calls[1].release();
    await bot.whenIdle();
    await bot.shutdown();
  });

  it('plays in different voice rooms concurrently and `stop in <room>` only stops that room', async () => {
    const { decodeClip, calls } = blockingDecoder();
    const { bot } = createHarness({ decodeClip, activeRooms: [LOUNGE, GAME] });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep', room: 'lounge' });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep', room: 'game night' });
    await tick();
    assert.equal(bot.playbacks.size, 2);

    await bot.handleCommand(CLIPS, { action: 'stop', room: 'lounge' });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    calls[1].release();
    await bot.whenIdle();
    await bot.shutdown();
  });

  it('shutdown aborts in-flight decodes instead of hanging', async () => {
    const { decodeClip, calls } = blockingDecoder();
    const { bot } = createHarness({ decodeClip });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await bot.shutdown();
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(bot.playbacks.size, 0);
  });
});

describe('SoundboardBot call.member refresh and SFU disconnect', () => {
  it('refreshes call.member before expiry, keeping created_ts and extending expires', async () => {
    const { bot, memberStates } = createHarness({ memberExpiresMs: 40 });
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await bot.whenIdle();
    await sleep(110);
    const joins = memberStates.filter((m) => m.content.application === 'm.call');
    assert.ok(joins.length >= 3, `expected initial + >=2 refreshes, got ${joins.length}`);
    assert.equal(new Set(joins.map((j) => j.content.created_ts)).size, 1);
    assert.ok(joins[1].content.expires > joins[0].content.expires);
    await bot.shutdown();
    const countAfterShutdown = memberStates.length;
    await sleep(60);
    assert.equal(memberStates.length, countAfterShutdown); // timer stopped
  });

  it('cleans up and tells #clips when the SFU disconnects, and can rejoin afterwards', async () => {
    const { bot, memberStates, rtcRooms, notices, sfuBodies } = createHarness();
    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await bot.whenIdle();
    assert.equal(bot.sessions.size, 1);

    rtcRooms[0].emit('disconnected', 'SERVER_SHUTDOWN');
    await tick();
    await tick();
    assert.equal(bot.sessions.size, 0);
    assert.deepEqual(memberStates.at(-1).content, {});
    assert.match(notices.at(-1).text, /Lost the voice connection/);

    await bot.handleCommand(CLIPS, { action: 'play', clip: 'beep' });
    await bot.whenIdle();
    assert.equal(sfuBodies.length, 2);
    assert.equal(bot.sessions.size, 1);
    await bot.shutdown();
  });
});

describe('config', () => {
  it('validates contract environment variables in loadConfigFromEnv', () => {
    assert.throws(() => loadConfigFromEnv({}), /Missing required environment variables/);
    const cfg = loadConfigFromEnv({
      CHAT_FQDN: 'chat.squadz.test',
      RTC_FQDN: 'rtc.squadz.test',
      SOUNDBOARD_MATRIX_USER: 'soundboard',
      SOUNDBOARD_MATRIX_PASSWORD: 'secret',
    });
    assert.equal(cfg.clipsDir, '/clips');
    assert.equal(cfg.rtcFqdn, 'rtc.squadz.test');
  });
});
