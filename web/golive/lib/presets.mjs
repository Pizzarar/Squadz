// Go-Live presets (docs/STREAMING.md section 2). Pure: no window/document.
export const PRESETS = {
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: { vp9: 6_000_000, av1: 6_000_000, h264: 8_000_000 }, audioBitrate: 128_000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: { vp9: 10_000_000, av1: 10_000_000, h264: 14_000_000 }, audioBitrate: 128_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: { vp9: 3_500_000, av1: 3_500_000, h264: 4_500_000 }, audioBitrate: 128_000 },
};
export const CODECS = ['vp9', 'av1', 'h264'];
export const DEFAULT_PRESET = '1080p60';
export const DEFAULT_CODEC = 'vp9';

export function getPreset(id) {
  const p = PRESETS[id];
  if (!p) throw new Error(`unknown preset: ${id}`);
  return p;
}

/** -> { videoCodec, maxBitrate, maxFramerate, width, height } */
export function encodingFor(presetId, codec = DEFAULT_CODEC) {
  const p = getPreset(presetId);
  if (!CODECS.includes(codec)) throw new Error(`unknown codec: ${codec}`);
  return { videoCodec: codec, maxBitrate: p.bitrate[codec], maxFramerate: p.fps, width: p.width, height: p.height };
}

/** Options for localParticipant.publishTrack (video). Names per livekit-client options.ts. */
export function videoPublishOptions(presetId, codec, screenShareSource = 'screen_share') {
  const e = encodingFor(presetId, codec);
  return {
    source: screenShareSource,
    videoCodec: e.videoCodec,
    backupCodec: true,
    simulcast: false,
    screenShareEncoding: { maxBitrate: e.maxBitrate, maxFramerate: e.maxFramerate, priority: 'high' },
    degradationPreference: 'maintain-framerate',
  };
}
