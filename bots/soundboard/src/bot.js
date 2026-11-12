// SoundboardBot orchestrator: ties together Matrix sync/invites, command dispatch,
// MatrixRTC call.member state management, lk-jwt-service token exchange, ffmpeg decoding,
// and LiveKit audio publishing.
import { parseCommand } from './commands.js';
import { ClipRegistry } from './clips.js';
import {
  buildCallMemberContent,
  buildLeaveCallMemberContent,
  findActiveCallMemberships,
  fetchLiveKitJwt,
} from './matrixrtc.js';
import { decodeClipToPcm } from './audio.js';
import { RoomCallSession, defaultRtcFactory } from './livekit.js';

export class SoundboardBot {
  /**
   * @param {object} opts
   * @param {import('./matrix.js').MatrixClient} opts.matrix
   * @param {string} opts.rtcFqdn
   * @param {string} opts.clipsDir
   * @param {number} [opts.idleTimeoutMs=60000]
   * @param {typeof decodeClipToPcm} [opts.decodeClip=decodeClipToPcm]
   * @param {() => Promise<object>} [opts.rtcFactory=defaultRtcFactory]
   * @param {typeof fetch} [opts.fetchImpl=fetch]
   * @param {Pick<Console, 'info'|'warn'|'error'>} [opts.logger=console]
   */
  constructor({
    matrix,
    rtcFqdn,
    clipsDir,
    idleTimeoutMs = 60_000,
    decodeClip = decodeClipToPcm,
    rtcFactory = defaultRtcFactory,
    fetchImpl = globalThis.fetch,
    logger = console,
  }) {
    if (!matrix || !rtcFqdn || !clipsDir) {
      throw new Error('matrix, rtcFqdn, and clipsDir are required');
    }
    this.matrix = matrix;
    this.rtcFqdn = rtcFqdn.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.clips = new ClipRegistry(clipsDir);
    this.idleTimeoutMs = idleTimeoutMs;
    this.decodeClip = decodeClip;
    this.rtcFactory = rtcFactory;
    this.fetchImpl = fetchImpl;
    this.logger = logger;

    /** @type {Map<string, RoomCallSession>} */
    this.sessions = new Map();
    this._running = false;
    this._syncToken = undefined;
  }

  /**
   * Process a single `/sync` payload:
   *  - Auto-join invited rooms (`rooms.invite`)
   *  - Handle timeline messages (`rooms.join`) when `processTimeline` is true
   *
   * On the very first sync (`processTimeline = false`), we advance `next_batch` and join
   * pending invites without replaying historical `!sb play` commands from before startup.
   *
   * @param {object} syncData
   * @param {object} [opts]
   * @param {boolean} [opts.processTimeline=true]
   */
  async handleSyncResponse(syncData, { processTimeline = true } = {}) {
    if (!syncData || typeof syncData !== 'object') return;
    const rooms = syncData.rooms || {};

    // 1. Accept any room invitations
    const invited = rooms.invite || {};
    for (const roomId of Object.keys(invited)) {
      try {
        await this.matrix.joinRoom(roomId);
        this.logger.info?.(`[soundboard] Joined invited room ${roomId}`);
      } catch (err) {
        this.logger.warn?.(`[soundboard] Failed to join invited room ${roomId}: ${err.message}`);
      }
    }

    if (!processTimeline) return;

    // 2. Process timeline events in joined rooms
    const joined = rooms.join || {};
    for (const [roomId, roomData] of Object.entries(joined)) {
      const events = roomData?.timeline?.events || [];
      for (const ev of events) {
        if (!ev || ev.type !== 'm.room.message') continue;
        if (ev.sender === this.matrix.userId) continue;
        const msgtype = ev.content?.msgtype;
        if (msgtype !== 'm.text') continue;
        const body = ev.content?.body;
        const cmd = parseCommand(body);
        if (!cmd) continue;

        try {
          await this.handleCommand(roomId, cmd);
        } catch (err) {
          this.logger.error?.(`[soundboard] Error handling command in ${roomId}: ${err.message}`);
        }
      }
    }
  }

  /**
   * Execute a parsed `!sb` command in `roomId`.
   *
   * @param {string} roomId
   * @param {{ action: 'list' | 'play' | 'stop' | 'help', clip?: string, error?: string }} cmd
   */
  async handleCommand(roomId, cmd) {
    if (cmd.action === 'help') {
      await this.matrix.sendNotice(
        roomId,
        `${cmd.error}. Commands: !sb list | !sb play <clip> | !sb stop`
      );
      return;
    }

    if (cmd.action === 'list') {
      const names = this.clips.list();
      const text =
        names.length > 0
          ? `Available clips (${names.length}): ${names.join(', ')}`
          : 'No clips found in /clips.';
      await this.matrix.sendNotice(roomId, text);
      return;
    }

    if (cmd.action === 'stop') {
      const session = this.sessions.get(roomId);
      if (session && session.connected) {
        session.stopPlayback();
        await this.matrix.sendNotice(roomId, 'Stopped playback.');
      } else {
        await this.matrix.sendNotice(roomId, 'Nothing is playing.');
      }
      return;
    }

    if (cmd.action === 'play') {
      const filePath = this.clips.resolve(cmd.clip);
      if (!filePath) {
        const names = this.clips.list();
        const hint = names.length > 0 ? ` Available: ${names.join(', ')}` : '';
        await this.matrix.sendNotice(roomId, `Unknown clip "${cmd.clip}".${hint}`);
        return;
      }

      // Check room state for an active MatrixRTC call before joining
      const stateEvents = await this.matrix.getRoomState(roomId);
      const activeMembers = findActiveCallMemberships(stateEvents, {
        excludeUserId: this.matrix.userId,
      });

      if (activeMembers.length === 0) {
        await this.matrix.sendNotice(
          roomId,
          'No active voice call in this room. Join the call first, then run !sb play.'
        );
        return;
      }

      const pcm = await this.decodeClip(filePath);
      const session = await this._ensureRoomSession(roomId, activeMembers[0]);
      await session.playPcm(pcm);
    }
  }

  /**
   * Ensure the bot has joined the active MatrixRTC call in `roomId` and is connected to LiveKit.
   *
   * @param {string} roomId
   * @param {{ callId?: string, livekitAlias?: string | null, livekitServiceUrl?: string | null }} [oldestMember]
   * @returns {Promise<RoomCallSession>}
   */
  async _ensureRoomSession(roomId, oldestMember) {
    const existing = this.sessions.get(roomId);
    if (existing && existing.connected) {
      return existing;
    }

    const livekitServiceUrl =
      oldestMember?.livekitServiceUrl || `https://${this.rtcFqdn}/livekit/jwt`;
    const targetRoomAlias = oldestMember?.livekitAlias || roomId;

    // 1. Exchange Matrix OpenID token for LiveKit {url, jwt} via lk-jwt-service
    const openIdToken = await this.matrix.requestOpenIdToken();
    const { url, jwt } = await fetchLiveKitJwt({
      rtcFqdn: this.rtcFqdn,
      roomId: targetRoomAlias,
      openIdToken,
      deviceId: this.matrix.deviceId,
      fetchImpl: this.fetchImpl,
    });

    // 2. Post org.matrix.msc3401.call.member state event per MSC4143
    const memberContent = buildCallMemberContent({
      deviceId: this.matrix.deviceId,
      roomId: targetRoomAlias,
      livekitServiceUrl,
      callId: oldestMember?.callId ?? '',
    });
    await this.matrix.putCallMemberState(roomId, memberContent);

    // 3. Connect to LiveKit SFU and publish audio track
    const session = new RoomCallSession({
      roomId,
      idleTimeoutMs: this.idleTimeoutMs,
      rtcFactory: this.rtcFactory,
      onLeave: async () => {
        this.sessions.delete(roomId);
        try {
          await this.matrix.putCallMemberState(roomId, buildLeaveCallMemberContent());
        } catch (err) {
          this.logger.warn?.(
            `[soundboard] Failed to clear call.member state in ${roomId}: ${err.message}`
          );
        }
      },
    });

    try {
      await session.connect(url, jwt);
    } catch (err) {
      // Roll back call.member state if SFU connection fails
      await this.matrix.putCallMemberState(roomId, buildLeaveCallMemberContent()).catch(() => {});
      throw err;
    }

    this.sessions.set(roomId, session);
    return session;
  }

  /**
   * Start long-polling `/_matrix/client/v3/sync`.
   */
  async start() {
    this._running = true;

    // Initial sync with timeout=0 to capture next_batch and join pending room invites
    const initial = await this.matrix.sync({ timeout: 0 });
    this._syncToken = initial.next_batch;
    await this.handleSyncResponse(initial, { processTimeline: false });

    while (this._running) {
      try {
        const res = await this.matrix.sync({ since: this._syncToken, timeout: 30000 });
        this._syncToken = res.next_batch;
        await this.handleSyncResponse(res, { processTimeline: true });
      } catch (err) {
        if (!this._running) break;
        this.logger.warn?.(`[soundboard] Sync error, retrying in 3s: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /**
   * Stop the bot, disconnect from all active LiveKit calls, and clear MatrixRTC call.member state.
   */
  async shutdown() {
    this._running = false;
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of activeSessions) {
      await session.disconnect();
    }
  }
}
