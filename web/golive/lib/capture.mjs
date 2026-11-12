import { getPreset } from './presets.mjs';

export function captureConstraints(presetId) {
  const p = getPreset(presetId);
  return {
    video: { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps, max: p.fps } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
    systemAudio: 'include',
    windowAudio: 'system',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
}

/** Browser-only. Returns { stream, settings, hasAudio }. */
export async function startCapture(presetId, md = navigator.mediaDevices) {
  const stream = await md.getDisplayMedia(captureConstraints(presetId));
  const [vt] = stream.getVideoTracks();
  if (vt && 'contentHint' in vt) vt.contentHint = 'motion';
  return { stream, settings: vt.getSettings(), hasAudio: stream.getAudioTracks().length > 0 };
}
