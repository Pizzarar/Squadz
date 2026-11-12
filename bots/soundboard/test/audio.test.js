import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SAMPLE_RATE,
  CHANNELS,
  SAMPLES_PER_FRAME,
  BYTES_PER_FRAME,
  chunkPcmToFrames,
  buildFfmpegArgs,
  decodeClipToPcm,
} from '../src/audio.js';
import { RoomCallSession } from '../src/livekit.js';

describe('PCM framing and ffmpeg decoding', () => {
  it('chunks 48 kHz mono s16le PCM into 960-sample (20 ms) Int16Array frames and zero-pads tail', () => {
    // 1 full frame (1920 bytes) + 4 bytes (2 samples) tail
    const buf = Buffer.alloc(BYTES_PER_FRAME + 4);
    buf.writeInt16LE(1234, 0);
    buf.writeInt16LE(-5678, BYTES_PER_FRAME);
    buf.writeInt16LE(42, BYTES_PER_FRAME + 2);

    const frames = chunkPcmToFrames(buf);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].length, SAMPLES_PER_FRAME);
    assert.equal(frames[0][0], 1234);
    assert.equal(frames[1].length, SAMPLES_PER_FRAME);
    assert.equal(frames[1][0], -5678);
    assert.equal(frames[1][1], 42);
    assert.equal(frames[1][2], 0); // zero-padded
  });

  it('frames the bundled beep.wav PCM payload into exact 20 ms frames', () => {
    const wavPath = fileURLToPath(new URL('../clips/beep.wav', import.meta.url));
    const wav = readFileSync(wavPath);
    // Strip 44-byte RIFF header; 0.4 s @ 48 kHz = 19,200 samples = 20 frames of 960 samples
    const pcm = wav.subarray(44);
    const frames = chunkPcmToFrames(pcm);
    assert.equal(frames.length, 20);
    assert.ok(frames.every((f) => f instanceof Int16Array && f.length === 960));
  });

  it('spawns ffmpeg with 48 kHz mono s16le flags and collects stdout via mock process', async () => {
    const args = buildFfmpegArgs('/clips/beep.wav');
    assert.ok(args.includes('-f') && args.includes('s16le'));
    assert.ok(args.includes('-ar') && args.includes(String(SAMPLE_RATE)));
    assert.ok(args.includes('-ac') && args.includes(String(CHANNELS)));

    const fakePcm = Buffer.alloc(BYTES_PER_FRAME, 7);
    let capturedCmd = null;
    let capturedArgs = null;

    const mockSpawn = (cmd, spawnArgs) => {
      capturedCmd = cmd;
      capturedArgs = spawnArgs;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit('data', fakePcm.subarray(0, 500));
        proc.stdout.emit('data', fakePcm.subarray(500));
        proc.emit('close', 0);
      });
      return proc;
    };

    const out = await decodeClipToPcm('/clips/beep.wav', { spawnImpl: mockSpawn });
    assert.equal(capturedCmd, 'ffmpeg');
    assert.ok(capturedArgs.includes('/clips/beep.wav'));
    assert.deepEqual(out, fakePcm);
  });

  it('rejects when ffmpeg exits non-zero', async () => {
    const mockSpawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('Invalid data found when processing input'));
        proc.emit('close', 1);
      });
      return proc;
    };

    await assert.rejects(
      () => decodeClipToPcm('/clips/corrupt.mp3', { spawnImpl: mockSpawn }),
      /ffmpeg exited with code 1: Invalid data found/
    );
  });
});

describe('RoomCallSession (mocked @livekit/rtc-node)', () => {
  it('connects, publishes track, streams AudioFrames, supports stop, and leaves after idle timeout', async () => {
    const capturedFrames = [];
    let clearedCount = 0;
    let disconnected = false;
    let leftCallbackCount = 0;

    const mockRtcFactory = async () => ({
      createRoom: () => ({
        connect: async () => {},
        disconnect: async () => {
          disconnected = true;
        },
        localParticipant: {
          publishTrack: async () => ({ sid: 'TR_TEST' }),
        },
      }),
      createAudioSource: () => ({
        captureFrame: async (frame) => {
          capturedFrames.push(frame);
        },
        waitForPlayout: async () => {},
        clearQueue: () => {
          clearedCount++;
        },
        close: async () => {},
      }),
      createAudioTrack: (name, source) => ({ name, source, close: async () => {} }),
      createAudioFrame: (data, sampleRate, channels, samplesPerChannel) => ({
        data,
        sampleRate,
        channels,
        samplesPerChannel,
      }),
      createPublishOptions: () => ({ source: 'microphone' }),
    });

    const session = new RoomCallSession({
      roomId: '!lounge:chat.squadz.test',
      idleTimeoutMs: 30,
      rtcFactory: mockRtcFactory,
      onLeave: async () => {
        leftCallbackCount++;
      },
    });

    await session.connect('wss://rtc.squadz.test/livekit/sfu', 'jwt_token');
    assert.equal(session.connected, true);

    const pcm = Buffer.alloc(BYTES_PER_FRAME * 3);
    const result = await session.playPcm(pcm);
    assert.equal(result.framesSent, 3);
    assert.equal(result.interrupted, false);
    assert.equal(capturedFrames.length, 3);
    assert.equal(capturedFrames[0].sampleRate, SAMPLE_RATE);
    assert.equal(capturedFrames[0].samplesPerChannel, SAMPLES_PER_FRAME);

    session.stopPlayback();
    assert.ok(clearedCount >= 2);

    // Wait for the 30 ms idle timeout to trigger disconnect + onLeave
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(session.connected, false);
    assert.equal(disconnected, true);
    assert.equal(leftCallbackCount, 1);
  });
});
