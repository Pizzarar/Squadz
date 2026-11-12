// LiveKit room session + audio publishing wrapper around `@livekit/rtc-node`.
// Isolated behind an injectable `rtcFactory` so unit tests can verify joining,
// track publishing, frame capture, stop/interruption, and idle disconnect without native WebRTC.
import {
  SAMPLE_RATE,
  CHANNELS,
  SAMPLES_PER_FRAME,
  chunkPcmToFrames,
} from './audio.js';

let cachedRtcModule = null;

/**
 * Default factory loading `@livekit/rtc-node` lazily at runtime.
 */
export async function defaultRtcFactory() {
  if (!cachedRtcModule) {
    cachedRtcModule = await import('@livekit/rtc-node');
  }
  const {
    Room,
    AudioSource,
    LocalAudioTrack,
    AudioFrame,
    TrackPublishOptions,
    TrackSource,
  } = cachedRtcModule;

  return {
    createRoom: () => new Room(),
    createAudioSource: (sampleRate, channels) => new AudioSource(sampleRate, channels),
    createAudioTrack: (name, source) => LocalAudioTrack.createAudioTrack(name, source),
    createAudioFrame: (data, sampleRate, channels, samplesPerChannel) =>
      new AudioFrame(data, sampleRate, channels, samplesPerChannel),
    createPublishOptions: () => {
      const opts = new TrackPublishOptions();
      if (TrackSource && TrackSource.SOURCE_MICROPHONE !== undefined) {
        opts.source = TrackSource.SOURCE_MICROPHONE;
      }
      return opts;
    },
  };
}

/**
 * Manages a single room's LiveKit connection, audio track, playback cancellation, and idle leave timer.
 */
export class RoomCallSession {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {number} [opts.idleTimeoutMs=60000]
   * @param {() => Promise<object>} [opts.rtcFactory=defaultRtcFactory]
   * @param {() => Promise<void>} [opts.onLeave]  Called before/when leaving so caller can clear Matrix state
   */
  constructor({
    roomId,
    idleTimeoutMs = 60_000,
    rtcFactory = defaultRtcFactory,
    onLeave = async () => {},
  }) {
    this.roomId = roomId;
    this.idleTimeoutMs = idleTimeoutMs;
    this.rtcFactory = rtcFactory;
    this.onLeave = onLeave;

    this.connected = false;
    this.rtc = null;
    this.room = null;
    this.audioSource = null;
    this.audioTrack = null;
    this._playToken = 0;
    this._idleTimer = null;
  }

  /**
   * Connect to the LiveKit SFU and publish the soundboard microphone track.
   *
   * @param {string} url
   * @param {string} jwt
   */
  async connect(url, jwt) {
    if (this.connected) return;
    this.rtc = await this.rtcFactory();
    this.room = this.rtc.createRoom();
    await this.room.connect(url, jwt, { autoSubscribe: false, dynacast: false });

    this.audioSource = this.rtc.createAudioSource(SAMPLE_RATE, CHANNELS);
    this.audioTrack = this.rtc.createAudioTrack('soundboard', this.audioSource);
    const pubOpts = this.rtc.createPublishOptions();
    await this.room.localParticipant.publishTrack(this.audioTrack, pubOpts);

    this.connected = true;
    this._resetIdleTimer();
  }

  /**
   * Stream a raw 48 kHz mono s16le PCM buffer into the published LiveKit AudioSource.
   * Preempts any currently playing clip on the same room session.
   *
   * @param {Buffer} pcmBuffer
   * @returns {Promise<{ framesSent: number, interrupted: boolean }>}
   */
  async playPcm(pcmBuffer) {
    if (!this.connected || !this.audioSource) {
      throw new Error('RoomCallSession is not connected');
    }
    this._clearIdleTimer();
    const myToken = ++this._playToken;

    if (typeof this.audioSource.clearQueue === 'function') {
      this.audioSource.clearQueue();
    }

    const frames = chunkPcmToFrames(pcmBuffer, {
      samplesPerChannel: SAMPLES_PER_FRAME,
      channels: CHANNELS,
    });

    let framesSent = 0;
    try {
      for (const samples of frames) {
        if (this._playToken !== myToken || !this.connected) {
          return { framesSent, interrupted: true };
        }
        const frame = this.rtc.createAudioFrame(
          samples,
          SAMPLE_RATE,
          CHANNELS,
          SAMPLES_PER_FRAME
        );
        await this.audioSource.captureFrame(frame);
        framesSent++;
      }

      if (
        this._playToken === myToken &&
        this.connected &&
        typeof this.audioSource.waitForPlayout === 'function'
      ) {
        await this.audioSource.waitForPlayout();
      }
      return { framesSent, interrupted: this._playToken !== myToken };
    } finally {
      if (this._playToken === myToken && this.connected) {
        this._resetIdleTimer();
      }
    }
  }

  /**
   * Stop any in-flight clip playback immediately.
   */
  stopPlayback() {
    this._playToken++;
    if (this.audioSource && typeof this.audioSource.clearQueue === 'function') {
      this.audioSource.clearQueue();
    }
    if (this.connected) {
      this._resetIdleTimer();
    }
  }

  /**
   * Disconnect from LiveKit, close track/source, and invoke `onLeave` callback.
   */
  async disconnect() {
    this._clearIdleTimer();
    this._playToken++;
    const wasConnected = this.connected;
    this.connected = false;

    if (this.audioSource && typeof this.audioSource.clearQueue === 'function') {
      try {
        this.audioSource.clearQueue();
      } catch {}
    }
    if (this.audioTrack && typeof this.audioTrack.close === 'function') {
      try {
        await this.audioTrack.close();
      } catch {}
    }
    if (this.audioSource && typeof this.audioSource.close === 'function') {
      try {
        await this.audioSource.close();
      } catch {}
    }
    if (this.room && typeof this.room.disconnect === 'function') {
      try {
        await this.room.disconnect();
      } catch {}
    }

    this.audioTrack = null;
    this.audioSource = null;
    this.room = null;

    if (wasConnected) {
      await this.onLeave();
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _resetIdleTimer() {
    this._clearIdleTimer();
    if (this.idleTimeoutMs > 0) {
      this._idleTimer = setTimeout(() => {
        this.disconnect().catch(() => {});
      }, this.idleTimeoutMs);
      if (typeof this._idleTimer.unref === 'function') {
        this._idleTimer.unref();
      }
    }
  }
}
