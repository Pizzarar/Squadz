import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, stripReplyFallback } from '../src/commands.js';
import {
  CLIP_NAME_RE,
  MAX_CLIP_BYTES,
  detectAudioFormat,
  parseMxc,
  powerLevelOf,
  removeClipFiles,
  saveClipAtomic,
} from '../src/upload.js';
import { MatrixClient } from '../src/matrix.js';
import { SoundboardBot } from '../src/bot.js';
import { sineWav } from '../src/wav.js';

const ROOM = '!clips:chat.test';
const ALICE = '@alice:chat.test';
const MOD = '@mod:chat.test';
const wav = (seconds = 0.2) => sineWav({ freq: 440, seconds, rate: 8000 });
const OGG = Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.alloc(20), Buffer.from('OpusHead\x01\x01'), Buffer.alloc(20)]);
const MP3_ID3 = Buffer.concat([Buffer.from('ID3\x03\0\0'), Buffer.alloc(30)]);

describe('parseCommand add/remove', () => {
  it('parses add, add --replace and remove', () => {
    assert.deepEqual(parseCommand('!sb add boom'), { action: 'add', clip: 'boom', replace: false });
    assert.deepEqual(parseCommand('!sb add boom --replace'), { action: 'add', clip: 'boom', replace: true });
    assert.deepEqual(parseCommand('!sb add --replace boom'), { action: 'add', clip: 'boom', replace: true });
    assert.deepEqual(parseCommand('!sb remove boom'), { action: 'remove', clip: 'boom' });
  });
  it('rejects bad names, extra args and unknown flags', () => {
    for (const body of ['!sb add', '!sb add A_B', '!sb add a.b', `!sb add ${'x'.repeat(33)}`, '!sb add a b', '!sb add a --force', '!sb remove a --replace', '!sb remove']) {
      assert.equal(parseCommand(body).action, 'help', body);
    }
    assert.equal(parseCommand(`!sb add ${'x'.repeat(32)}`).action, 'add');
  });
  it('strips the legacy reply fallback', () => {
    assert.equal(stripReplyFallback('> <@a:b> clip.wav\n\n!sb add boom'), '!sb add boom');
    assert.equal(stripReplyFallback('!sb add boom'), '!sb add boom');
  });
});

describe('clip name regex', () => {
  it('requires an alphanumeric first char (matches sanitizeClipName)', () => {
    for (const bad of ['-x', '_x', '--x', '_', '-']) assert.equal(CLIP_NAME_RE.test(bad), false, bad);
    for (const good of ['x', '0a', 'a_b-c', 'x'.repeat(32)]) assert.equal(CLIP_NAME_RE.test(good), true, good);
    assert.equal(CLIP_NAME_RE.test('x'.repeat(33)), false);
  });
  it('parser rejects names starting with - or _', () => {
    for (const body of ['!sb add -x', '!sb add _x', '!sb remove -x', '!sb remove _x']) {
      assert.equal(parseCommand(body).action, 'help', body);
    }
  });
});

describe('detectAudioFormat (magic bytes)', () => {
  it('accepts wav, ogg/opus, mp3 (ID3 and bare frame)', () => {
    assert.equal(detectAudioFormat(wav()).ext, '.wav');
    assert.equal(detectAudioFormat(OGG).ext, '.ogg');
    assert.equal(detectAudioFormat(MP3_ID3).ext, '.mp3');
    assert.equal(detectAudioFormat(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(20)])).ext, '.mp3');
  });
  it('rejects everything else regardless of claimed type', () => {
    assert.equal(detectAudioFormat(Buffer.from('MZ' + 'x'.repeat(40))), null); // exe
    assert.equal(detectAudioFormat(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)])), null); // ogg w/o opus
    assert.equal(detectAudioFormat(Buffer.from('RIFF\0\0\0\0AVI LIST')), null);
    assert.equal(detectAudioFormat(Buffer.from('fLaC' + 'x'.repeat(40))), null);
    assert.equal(detectAudioFormat(Buffer.alloc(4)), null);
    assert.equal(detectAudioFormat('text'), null);
  });
  it('parses mxc uris', () => {
    assert.deepEqual(parseMxc('mxc://chat.test/AbC_-1'), { server: 'chat.test', mediaId: 'AbC_-1' });
    assert.equal(parseMxc('https://x/y'), null);
    assert.equal(parseMxc('mxc://chat.test/a/../b'), null);
  });
});

describe('powerLevelOf', () => {
  const pl = { users: { [MOD]: 50, '@admin:chat.test': 100 }, users_default: 0 };
  it('reads users / users_default', () => {
    assert.equal(powerLevelOf(MOD, pl), 50);
    assert.equal(powerLevelOf(ALICE, pl), 0);
    assert.equal(powerLevelOf(ALICE, { users_default: 60 }), 60);
  });
  it('room v12 creators are infinite; no PL event falls back to creator=100', () => {
    const v12 = { sender: '@owner:chat.test', content: { room_version: '12', additional_creators: ['@co:chat.test'] } };
    assert.equal(powerLevelOf('@owner:chat.test', pl, v12), Infinity);
    assert.equal(powerLevelOf('@co:chat.test', pl, v12), Infinity);
    assert.equal(powerLevelOf(ALICE, pl, v12), 0);
    assert.equal(powerLevelOf('@owner:chat.test', pl, { sender: '@owner:chat.test', content: { room_version: '10' } }), 0);
    assert.equal(powerLevelOf('@owner:chat.test', null, { sender: '@owner:chat.test', content: {} }), 100);
  });
});

describe('saveClipAtomic', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-clips-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes via temp file then rename; no temp left behind', async () => {
    let seenTmp;
    const p = await saveClipAtomic(dir, 'boom', wav(), '.wav', {
      validate: (tmp) => { seenTmp = tmp; assert.match(tmp, /\.tmp$/); assert.equal(readdirSync(dir).length, 1); },
    });
    assert.equal(p, join(dir, 'boom.wav'));
    assert.deepEqual(readdirSync(dir), ['boom.wav']);
    assert.ok(seenTmp);
  });
  it('failed validation leaves nothing and never creates the clip', async () => {
    await assert.rejects(saveClipAtomic(dir, 'boom', wav(), '.wav', { validate: () => { throw new Error('nope'); } }), /nope/);
    assert.deepEqual(readdirSync(dir), []);
  });
  it('refuses to overwrite unless replace; replace drops other-extension duplicates', async () => {
    writeFileSync(join(dir, 'boom.mp3'), MP3_ID3);
    await assert.rejects(saveClipAtomic(dir, 'boom', wav(), '.wav'), (e) => e.code === 'EEXISTS');
    assert.deepEqual(readdirSync(dir), ['boom.mp3']);
    await saveClipAtomic(dir, 'boom', wav(), '.wav', { replace: true });
    assert.deepEqual(readdirSync(dir), ['boom.wav']);
  });
  it('rejects unsafe names', async () => {
    await assert.rejects(saveClipAtomic(dir, '../evil', wav(), '.wav'), /invalid clip name/);
  });
  it('removeClipFiles deletes all extensions of a stem', () => {
    writeFileSync(join(dir, 'a.wav'), 'x'); writeFileSync(join(dir, 'a.ogg'), 'x'); writeFileSync(join(dir, 'b.wav'), 'x');
    assert.equal(removeClipFiles(dir, 'a'), 2);
    assert.deepEqual(readdirSync(dir), ['b.wav']);
  });
});

describe('MatrixClient.downloadMedia', () => {
  const mk = (responses) => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return responses.shift(); };
    return { calls, client: new MatrixClient({ homeserverUrl: 'https://chat.test', accessToken: 'tok', fetchImpl }) };
  };
  const ok = (buf, headers = {}) => new Response(buf, { status: 200, headers });
  it('uses authenticated v1 endpoint with bearer token', async () => {
    const { calls, client } = mk([ok(Buffer.from('abc'))]);
    assert.equal((await client.downloadMedia('chat.test', 'id1')).toString(), 'abc');
    assert.equal(calls[0].url, 'https://chat.test/_matrix/client/v1/media/download/chat.test/id1');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
  });
  it('falls back to v3 on 404', async () => {
    const { calls, client } = mk([new Response('', { status: 404 }), ok(Buffer.from('x'))]);
    await client.downloadMedia('chat.test', 'id1');
    assert.match(calls[1].url, /\/_matrix\/media\/v3\/download\/chat\.test\/id1$/);
  });
  it('cancels the body when Content-Length already exceeds maxBytes', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } });
    const { client } = mk([new Response(body, { status: 200, headers: { 'content-length': '999' } })]);
    await assert.rejects(client.downloadMedia('s', 'i', { maxBytes: 10 }), (e) => e.code === 'TOO_LARGE');
    assert.equal(cancelled, true);
  });
  it('enforces maxBytes on the stream', async () => {
    const { client } = mk([ok(Buffer.alloc(100))]);
    await assert.rejects(client.downloadMedia('s', 'i', { maxBytes: 10 }), (e) => e.code === 'TOO_LARGE');
  });
});

describe('bot !sb add / remove', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-bot-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup({ media = wav(), content, pcmSeconds = 1, power = { users: { [MOD]: 50 } } } = {}) {
    const notices = [];
    const downloads = [];
    const matrix = {
      userId: '@bot:chat.test',
      sendNotice: async (_r, t) => { notices.push(t); },
      getEvent: async () => ({ content: content ?? { msgtype: 'm.audio', url: 'mxc://chat.test/abc', info: { size: media.length } } }),
      downloadMedia: async (server, id, opts) => { downloads.push({ server, id, opts }); if (media.length > opts.maxBytes) { const e = new Error('big'); e.code = 'TOO_LARGE'; throw e; } return media; },
      getRoomState: async () => [
        { type: 'm.room.create', state_key: '', sender: '@owner:chat.test', content: { room_version: '10' } },
        { type: 'm.room.power_levels', state_key: '', content: power },
      ],
    };
    const bot = new SoundboardBot({
      matrix, rtcFqdn: 'rtc.test', clipsDir: dir, commandRoomId: ROOM,
      decodeClip: async () => Buffer.alloc(Math.round(pcmSeconds * 96000)),
      logger: { info() {}, warn() {}, error() {} },
    });
    const add = (clip, sender = ALICE, replace = false) => bot.handleCommand(ROOM, { action: 'add', clip, replace }, { sender, replyToEventId: '$ev' });
    return { bot, notices, downloads, add };
  }

  it('saves a new clip that is immediately listed/resolvable (no restart)', async () => {
    const { bot, notices, downloads, add } = setup();
    assert.equal(bot.clips.resolve('boom'), null);
    await add('boom');
    assert.match(notices[0], /^Saved clip "boom"/);
    assert.deepEqual(downloads[0], { server: 'chat.test', id: 'abc', opts: { maxBytes: MAX_CLIP_BYTES } });
    assert.ok(bot.clips.resolve('boom').endsWith('boom.wav'));
    assert.deepEqual(bot.clips.list(), ['boom']);
    assert.deepEqual(readFileSync(join(dir, 'boom.wav')), wav());
  });
  it('rejects without a reply, non-audio target, bad magic, too long, too large', async () => {
    let s = setup();
    await s.bot.handleCommand(ROOM, { action: 'add', clip: 'x', replace: false }, { sender: ALICE });
    assert.match(s.notices[0], /^Rejected "x": reply to an audio/);

    s = setup({ content: { msgtype: 'm.text', body: 'hi' } });
    await s.add('x');
    assert.match(s.notices[0], /not an audio file/);

    s = setup({ media: Buffer.from('MZ' + 'x'.repeat(100)) });
    await s.add('x');
    assert.match(s.notices[0], /unsupported format/);

    s = setup({ pcmSeconds: 15.5 });
    await s.add('x');
    assert.match(s.notices[0], /15\.5 s long \(max 15 s\)/);
    assert.deepEqual(readdirSync(dir), []);

    s = setup({ media: Buffer.concat([wav(), Buffer.alloc(MAX_CLIP_BYTES)]), content: { msgtype: 'm.audio', url: 'mxc://chat.test/abc', info: {} } });
    await s.add('x');
    assert.match(s.notices[0], /larger than 1 MB/);
  });
  it('accepts m.file with audio mimetype', async () => {
    const { notices, add } = setup({ content: { msgtype: 'm.file', url: 'mxc://chat.test/abc', info: { mimetype: 'audio/wav' } } });
    await add('filey');
    assert.match(notices[0], /^Saved/);
  });
  it('duplicate name needs --replace, and --replace needs mod', async () => {
    const { notices, add } = setup();
    await add('boom');
    await add('boom');
    assert.match(notices[1], /already exists/);
    await add('boom', ALICE, true);
    assert.match(notices[2], /--replace needs moderator/);
    await add('boom', MOD, true);
    assert.match(notices[3], /^Saved clip "boom"/);
  });
  it('remove is mod-only', async () => {
    const { bot, notices, add } = setup();
    await add('boom');
    await bot.handleCommand(ROOM, { action: 'remove', clip: 'boom' }, { sender: ALICE });
    assert.match(notices[1], /Only moderators/);
    assert.deepEqual(bot.clips.list(), ['boom']);
    await bot.handleCommand(ROOM, { action: 'remove', clip: 'boom' }, { sender: MOD });
    assert.match(notices[2], /Removed clip "boom"/);
    assert.deepEqual(bot.clips.list(), []);
    await bot.handleCommand(ROOM, { action: 'remove', clip: 'boom' }, { sender: MOD });
    assert.match(notices[3], /Unknown clip/);
  });
  it('sync: reply with fallback body dispatches add with the replied-to event id', async () => {
    const { bot, notices } = setup();
    await bot.handleSyncResponse({
      rooms: { join: { [ROOM]: { timeline: { events: [{
        type: 'm.room.message', sender: ALICE,
        content: { msgtype: 'm.text', body: '> <@bob:chat.test> clip.wav\n\n!sb add synced', 'm.relates_to': { 'm.in_reply_to': { event_id: '$ev' } } },
      }] } } } },
    });
    // add runs off the /sync loop: handleSyncResponse returns before the notice is sent
    await bot.whenIdle();
    assert.match(notices[0], /^Saved clip "synced"/);
  });
  it('sync loop is not blocked by a slow add', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { bot, notices } = setup();
    bot.decodeClip = async () => { await gate; return Buffer.alloc(96000); };
    await bot.handleSyncResponse({
      rooms: { join: { [ROOM]: { timeline: { events: [{
        type: 'm.room.message', sender: ALICE,
        content: { msgtype: 'm.text', body: '!sb add slow', 'm.relates_to': { 'm.in_reply_to': { event_id: '$ev' } } },
      }] } } } },
    });
    assert.deepEqual(notices, []); // returned while the decode is still pending
    release();
    await bot.whenIdle();
    assert.match(notices[0], /^Saved clip "slow"/);
  });
  it('passes a timeout signal + PCM cap to decodeClip; a timeout is reported, not hung', async () => {
    const { bot, notices, add } = setup();
    let opts;
    bot.addDecodeTimeoutMs = 20;
    bot.decodeClip = (_p, o) => { opts = o; return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })))); };
    await add('hang');
    assert.equal(opts.maxBytes, 16 * 96000);
    assert.match(notices[0], /decoding timed out/);
    assert.deepEqual(readdirSync(dir), []);
  });
  it('PCM_TOO_LARGE from the decoder is reported as too long', async () => {
    const { bot, notices, add } = setup();
    bot.decodeClip = async () => { throw Object.assign(new Error('big'), { code: 'PCM_TOO_LARGE' }); };
    await add('huge');
    assert.match(notices[0], /longer than 15 s/);
  });
  it('shutdown() aborts an in-flight add decode', async () => {
    const { bot, notices, add } = setup();
    bot.decodeClip = (_p, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }))));
    const started = new Promise((resolve) => {
      const inner = bot.decodeClip;
      bot.decodeClip = (...a) => { resolve(); return inner(...a); };
    });
    const p = add('stuck');
    await started; // decode is in flight: no timers involved
    await bot.shutdown();
    await p;
    assert.match(notices[0], /timed out or was cancelled/);
  });
});
