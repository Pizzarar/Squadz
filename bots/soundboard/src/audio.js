// Decodes audio files via ffmpeg to 48 kHz mono 16-bit signed LE PCM and slices into 20 ms frames.
import { spawn as defaultSpawn } from 'node:child_process';

export const SAMPLE_RATE = 48000;
export const CHANNELS = 1;
export const FRAME_DURATION_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const BYTES_PER_SAMPLE = 2; // s16le
export const BYTES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS * BYTES_PER_SAMPLE; // 1920 bytes

/**
 * Slice a raw s16le PCM Buffer into fixed-size `Int16Array` frames.
 * Any trailing partial frame is zero-padded to a full frame so no tail audio is clipped.
 *
 * @param {Buffer} pcmBuffer
 * @param {object} [opts]
 * @param {number} [opts.samplesPerChannel=SAMPLES_PER_FRAME]
 * @param {number} [opts.channels=CHANNELS]
 * @returns {Int16Array[]}
 */
export function chunkPcmToFrames(
  pcmBuffer,
  { samplesPerChannel = SAMPLES_PER_FRAME, channels = CHANNELS } = {}
) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) return [];

  const samplesPerFrameTotal = samplesPerChannel * channels;
  const frameBytes = samplesPerFrameTotal * BYTES_PER_SAMPLE;
  // Drop any stray odd trailing byte so Int16 reads stay aligned
  const alignedLen = pcmBuffer.length - (pcmBuffer.length % BYTES_PER_SAMPLE);
  if (alignedLen === 0) return [];

  const frames = [];
  for (let offset = 0; offset < alignedLen; offset += frameBytes) {
    const remaining = alignedLen - offset;
    const samples = new Int16Array(samplesPerFrameTotal);
    const chunkBytes = Math.min(remaining, frameBytes);
    const sampleCount = chunkBytes / BYTES_PER_SAMPLE;
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = pcmBuffer.readInt16LE(offset + i * BYTES_PER_SAMPLE);
    }
    frames.push(samples);
  }
  return frames;
}

/**
 * Build the ffmpeg CLI arguments used to decode `filePath` to 48 kHz mono s16le PCM on stdout.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
export function buildFfmpegArgs(filePath) {
  return [
    '-nostdin',
    '-v',
    'error',
    '-i',
    filePath,
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ar',
    String(SAMPLE_RATE),
    '-ac',
    String(CHANNELS),
    'pipe:1',
  ];
}

/**
 * Decode an audio file using `ffmpeg` into a raw 48 kHz mono s16le Buffer.
 * Accepts an injectable `spawnImpl` so tests run without requiring `ffmpeg` on the host.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {typeof defaultSpawn} [opts.spawnImpl=defaultSpawn]
 * @param {string} [opts.ffmpegBin='ffmpeg']
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxBytes=Infinity]  kill ffmpeg and reject (`code: 'PCM_TOO_LARGE'`) once stdout exceeds this
 * @returns {Promise<Buffer>}
 */
export function decodeClipToPcm(
  filePath,
  { spawnImpl = defaultSpawn, ffmpegBin = 'ffmpeg', signal, maxBytes = Infinity } = {}
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const args = buildFfmpegArgs(filePath);
    // The abort is handled explicitly (kill + reject) instead of via spawn's `signal` option so the
    // behaviour is identical for injected spawn implementations.
    const proc = spawnImpl(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(reject, abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let stdoutBytes = 0;
    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        try {
          proc.kill('SIGKILL');
        } catch {}
        const err = new Error(`decoded audio exceeds ${maxBytes} bytes`);
        err.code = 'PCM_TOO_LARGE';
        finish(reject, err);
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    proc.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    proc.on('error', (err) => finish(reject, err));

    proc.on('close', (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(stderrChunks).toString('utf8').trim();
        finish(reject, new Error(`ffmpeg exited with code ${code}${errMsg ? `: ${errMsg}` : ''}`));
        return;
      }
      finish(resolve, Buffer.concat(stdoutChunks));
    });
  });
}

export function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err) {
  return err?.name === 'AbortError';
}
