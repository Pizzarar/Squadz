import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, encodingFor, videoPublishOptions } from '../lib/presets.mjs';
import { captureConstraints } from '../lib/capture.mjs';
import * as mx from '../lib/matrix.mjs';
import { buildSfuBody, fetchSfuToken } from '../lib/lkjwt.mjs';
import * as bot from '../../../bots/soundboard/src/matrixrtc.js';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('presets', () => {
  it('selects bitrate by preset and codec', () => {
    assert.deepEqual(encodingFor('1080p60', 'vp9'), { videoCodec: 'vp9', maxBitrate: 6_000_000, maxFramerate: 60, width: 1920, height: 1080 });
    assert.equal(encodingFor('1440p60', 'h264').maxBitrate, 14_000_000);
    assert.equal(encodingFor('1080p30', 'av1').maxFramerate, 30);
    assert.equal(Object.keys(PRESETS).length, 3);
  });
  it('rejects unknown preset/codec', () => {
    assert.throws(() => encodingFor('720p', 'vp9'));
    assert.throws(() => encodingFor('1080p60', 'vp8'));
  });
  it('builds publish options', () => {
    const o = videoPublishOptions('1440p60', 'av1');
    assert.equal(o.simulcast, false);
    assert.equal(o.degradationPreference, 'maintain-framerate');
    assert.deepEqual(o.screenShareEncoding, { maxBitrate: 10_000_000, maxFramerate: 60, priority: 'high' });
  });
  it('capture constraints follow the preset', () => {
    const c = captureConstraints('1440p60');
    assert.equal(c.video.width.ideal, 2560);
    assert.equal(c.video.frameRate.max, 60);
    assert.equal(c.audio.echoCancellation, false);
    assert.equal(c.systemAudio, 'include');
  });
});

describe('well-known + rooms', () => {
  const wk = { 'm.homeserver': { base_url: 'https://chat.x' }, 'org.matrix.msc4143.rtc_foci': [{ type: 'livekit', livekit_service_url: 'https://rtc.x/livekit/jwt/' }] };
  it('resolves livekit_service_url from /.well-known/matrix/client', async () => {
    let url;
    const u = await mx.resolveLivekitServiceUrl('https://chat.x/', async (x) => { url = x; return json(200, wk); });
    assert.equal(url, 'https://chat.x/.well-known/matrix/client');
    assert.equal(u, 'https://rtc.x/livekit/jwt');
  });
  it('errors when no foci or fetch fails', async () => {
    assert.throws(() => mx.pickLivekitServiceUrl({}), /rtc_foci/);
    await assert.rejects(mx.resolveLivekitServiceUrl('https://c', async () => json(404, {})), /404/);
  });
  it('defaults rooms to #game-night then #lounge', () => {
    assert.deepEqual(mx.defaultRoomAliases('chat.x'), ['#game-night:chat.x', '#lounge:chat.x']);
    assert.equal(mx.serverNameFromUserId('@a:chat.x'), 'chat.x');
  });
  it('resolveRoom passes ids through and url-encodes aliases', async () => {
    assert.equal(await mx.resolveRoom('https://c', '!r:c', 't'), '!r:c');
    let url;
    const id = await mx.resolveRoom('https://c', '#game-night:c', 't', async (x) => { url = x; return json(200, { room_id: '!g:c' }); });
    assert.equal(id, '!g:c');
    assert.match(url, /directory\/room\/%23game-night%3Ac$/);
  });
});

describe('call.member', () => {
  const p = { deviceId: 'DEV', roomId: '!r:c', livekitServiceUrl: 'https://rtc.x/livekit/jwt', createdTs: 1 };
  it('matches the soundboard bot byte for byte', () => {
    assert.deepEqual(mx.buildCallMemberContent(p), bot.buildCallMemberContent(p));
    assert.equal(mx.buildCallMemberStateKey('@a:c', 'DEV'), bot.buildCallMemberStateKey('@a:c', 'DEV'));
    assert.equal(mx.CALL_MEMBER_EVENT_TYPE, bot.CALL_MEMBER_EVENT_TYPE);
  });
  it('PUTs content, and {} on clear, to the right path', async () => {
    const calls = [];
    const f = async (url, init) => { calls.push({ url, init }); return json(200, { event_id: '$e' }); };
    const base = { homeserver: 'https://c', roomId: '!r:c', userId: '@a:c', deviceId: 'DEV', token: 'tok', fetchImpl: f };
    await mx.sendCallMember({ ...base, livekitServiceUrl: p.livekitServiceUrl, createdTs: 1 });
    await mx.clearCallMember(base);
    assert.equal(calls[0].init.method, 'PUT');
    assert.match(calls[0].url, /state\/org\.matrix\.msc3401\.call\.member\/_%40a%3Ac_DEV_m\.call$/);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
    assert.equal(JSON.parse(calls[0].init.body).application, 'm.call');
    assert.deepEqual(JSON.parse(calls[1].init.body), {});
  });
  it('shows a clear error on 403 (no power level)', async () => {
    const f = async () => json(403, { errcode: 'M_FORBIDDEN', error: 'nope' });
    await assert.rejects(
      mx.sendCallMember({ homeserver: 'https://c', roomId: '!r:c', userId: '@a:c', deviceId: 'D', token: 't', livekitServiceUrl: 'u', fetchImpl: f }),
      /do not have permission.*call\.member/,
    );
  });
  it('login posts the password flow', async () => {
    let body;
    const r = await mx.login('https://c', 'bob', 'pw', async (_u, init) => { body = JSON.parse(init.body); return json(200, { access_token: 'a', user_id: '@bob:c', device_id: 'D' }); });
    assert.deepEqual(r, { accessToken: 'a', userId: '@bob:c', deviceId: 'D' });
    assert.equal(body.identifier.user, 'bob');
    assert.equal(body.type, 'm.login.password');
  });
});

describe('/sfu/get', () => {
  it('body is { room, openid_token, device_id } with the roomId', () => {
    const t = { access_token: 'o', matrix_server_name: 'c' };
    assert.deepEqual(buildSfuBody({ roomId: '!r:c', openIdToken: t, deviceId: 'D' }), { room: '!r:c', openid_token: t, device_id: 'D' });
  });
  it('refuses an alias as room', () => {
    assert.throws(() => buildSfuBody({ roomId: '#a:c', openIdToken: {}, deviceId: 'D' }), /roomId/);
  });
  it('POSTs to <service>/sfu/get and matches the bot request body', async () => {
    const reqs = [];
    const f = async (url, init) => { reqs.push({ url, body: init.body }); return json(200, { url: 'wss://l', jwt: 'j' }); };
    const args = { roomId: '!r:c', openIdToken: { access_token: 'o' }, deviceId: 'D' };
    const out = await fetchSfuToken({ livekitServiceUrl: 'https://rtc.x/livekit/jwt', ...args, fetchImpl: f });
    await bot.fetchLiveKitJwt({ rtcFqdn: 'rtc.x', ...args, fetchImpl: f });
    assert.deepEqual(out, { url: 'wss://l', jwt: 'j' });
    assert.equal(reqs[0].url, 'https://rtc.x/livekit/jwt/sfu/get');
    assert.equal(reqs[0].url, reqs[1].url);
    assert.equal(reqs[0].body, reqs[1].body);
  });
  it('rejects bad responses', async () => {
    await assert.rejects(fetchSfuToken({ livekitServiceUrl: 'u', roomId: '!r:c', openIdToken: {}, deviceId: 'D', fetchImpl: async () => json(500, {}) }), /500/);
    await assert.rejects(fetchSfuToken({ livekitServiceUrl: 'u', roomId: '!r:c', openIdToken: {}, deviceId: 'D', fetchImpl: async () => json(200, {}) }), /invalid/);
  });
});

describe('publish / stats / cleanup (mocks)', () => {
  const mkStream = () => ({ getVideoTracks: () => [{ addEventListener() {} }], getAudioTracks: () => [] });
  it('videoStats takes the first VideoSenderStats element, prefers currentBitrate', async () => {
    const { videoStats } = await import('../lib/publish.mjs');
    const mk = (cur) => ({ localParticipant: { videoTrackPublications: new Map([['a', { track: { currentBitrate: cur, getSenderStats: async () => [{ targetBitrate: 5e6, framesPerSecond: 60, frameWidth: 1920, frameHeight: 1080 }, { frameWidth: 640 }] } }]]) } });
    assert.deepEqual(await videoStats(mk(4e6)), { bitrate: 4e6, fps: 60, w: 1920, h: 1080 });
    assert.equal((await videoStats(mk(0))).bitrate, 5e6);
    const empty = { localParticipant: { videoTrackPublications: new Map([['a', { track: { getSenderStats: async () => [] } }]]) } };
    assert.equal(await videoStats(empty), null);
  });
  it('publish disconnects the room and rethrows when publishTrack fails', async () => {
    const { publish } = await import('../lib/publish.mjs');
    let disconnected = 0;
    class FakeRoom {
      localParticipant = { publishTrack: async () => { throw new Error('boom'); } };
      async connect() {}
      async disconnect() { disconnected++; }
      on() {}
    }
    await assert.rejects(publish({ url: 'u', jwt: 'j', stream: mkStream(), preset: '1080p60', codec: 'vp9', RoomImpl: FakeRoom }), /boom/);
    assert.equal(disconnected, 1);
  });
  it('clearCallMember sends keepalive only when asked', async () => {
    const inits = [];
    const f = async (_u, init) => { inits.push(init); return json(200, {}); };
    const a = { homeserver: 'https://h', roomId: '!r:c', userId: '@a:c', deviceId: 'D', token: 't', fetchImpl: f };
    await mx.clearCallMember(a);
    await mx.clearCallMember({ ...a, keepalive: true });
    assert.equal(inits[0].keepalive, undefined);
    assert.equal(inits[1].keepalive, true);
    assert.equal(inits[1].body, '{}');
  });
});
