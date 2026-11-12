// Browser-only (livekit-client 2.23.0 vendored). Manual publishTrack per docs/STREAMING.md section 6.
import { Room, RoomEvent, Track, AudioPresets } from '../vendor/livekit-client.esm.mjs';
import { videoPublishOptions } from './presets.mjs';

export async function publish({ url, jwt, stream, preset, codec, onEnded }) {
  const room = new Room();
  await room.connect(url, jwt);
  const [vt] = stream.getVideoTracks();
  const [at] = stream.getAudioTracks();
  await room.localParticipant.publishTrack(vt, videoPublishOptions(preset, codec, Track.Source.ScreenShare));
  if (at) {
    await room.localParticipant.publishTrack(at, {
      source: Track.Source.ScreenShareAudio,
      forceStereo: true,
      dtx: false,
      red: false,
      audioPreset: AudioPresets.musicHighQualityStereo,
    });
  }
  room.on(RoomEvent.Disconnected, () => onEnded && onEnded());
  vt.addEventListener('ended', () => onEnded && onEnded());
  return room;
}

export async function stop(room, stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (room) await room.disconnect();
}

/** Viewer: connect without publishing. */
export async function watch({ url, jwt, onTrack, onRemoved, onEnded }) {
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => onTrack(track, participant));
  room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => onRemoved && onRemoved(track, participant));
  room.on(RoomEvent.Disconnected, () => onEnded && onEnded());
  await room.connect(url, jwt);
  return room;
}

export async function videoStats(room) {
  const pub = [...room.localParticipant.videoTrackPublications.values()][0];
  const s = pub && pub.track && (await pub.track.getSenderStats());
  return s ? { bitrate: s.targetBitrate, fps: s.framesPerSecond, w: s.frameWidth, h: s.frameHeight } : null;
}
