// SoundboardBot orchestrator: ties together Matrix sync/invites, command dispatch,
// MatrixRTC call.member state management, lk-jwt-service token exchange, ffmpeg decoding,
// and LiveKit audio publishing.
//
// Commands are read ONLY in the unencrypted #clips room. The voice rooms are E2EE, so the bot
// never needs to read their timelines; it only reads their (unencrypted) state events.
import { parseCommand } from './commands.js';
import { ClipRegistry } from './clips.js';
import {
  DEFAULT_EXPIRES_MS,
  buildCallMemberContent,
  buildLeaveCallMemberContent,
  findActiveCallMemberships,
  fetchLiveKitJwt,
} from './matrixrtc.js';
import { decodeClipToPcm, isAbortError, abortError } from './audio.js';
import { resolveVoiceRoom } from './rooms.js';
import { RoomCallSession, defaultRtcFactory } from './livekit.js';

export class SoundboardBot {
  /**
   * @param {object} opts
   * @param {import('./matrix.js').MatrixClient} opts.matrix
   * @param {string} opts.rtcFqdn
   * @param {string} opts.clipsDir
   * @param {string} [opts.commandRoomId]     Room ID of #clips (the only room commands are read in)
   * @param {string} [opts.commandRoomAlias]  e.g. `#clips:chat.example.com`, resolved lazily if no ID
   * @param {number} [opts.idleTimeoutMs=60000]
   * @param {number} [opts.memberExpiresMs=DEFAULT_EXPIRES_MS]  call.member `expires`; refreshed at half this
   * @param {typeof decodeClipToPcm} [opts.decodeClip=decodeClipToPcm]
   * @param {() => Promise<object>} [opts.rtcFactory=defaultRtcFactory]
   * @param {typeof fetch} [opts.fetchImpl=fetch]
   * @param {Pick<Console, 'info'|'warn'|'error'>} [opts.logger=console]
   */
  constructor({
    matrix,
    rtcFqdn,
    clipsDir,
    commandRoomId = null,
    commandRoomAlias = null,
    idleTimeoutMs = 60_000,
    memberExpiresMs = DEFAULT_EXPIRES_MS,
    decodeClip = decodeClipToPcm,
    rtcFactory = defaultRtcFactory,
    fetchImpl = globalThis.fetch,
    logger = console,
  }) {
    if (!matrix || !rtcFqdn || !clipsDir) {
      throw new Error('matrix, rtcFqdn, and clipsDir are required');
    }
    if (!commandRoomId && !commandRoomAlias) {
      throw new Error('commandRoomId or commandRoomAlias is required');
    }
    this.matrix = matrix;
    this.rtcFqdn = rtcFqdn.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.clips = new ClipRegistry(clipsDir);
    this.commandRoomId = commandRoomId;
    this.commandRoomAlias = commandRoomAlias;
    this.idleTimeoutMs = idleTimeoutMs;
    this.memberExpiresMs = memberExpiresMs;
    this.decodeClip = decodeClip;
    this.rtcFactory = rtcFactory;
    this.fetchImpl = fetchImpl;
    this.logger = logger;

    /** @type {Map<string, RoomCallSession>} */
    this.sessions = new Map();
    /** One active playback per voice room. @type {Map<string, { controller: AbortController, promise: Promise<void> }>} */
    this.playbacks = new Map();
    this._running = false;
    this._syncToken = undefined;
  }

  /** Resolve (and cache) the #clips room ID; returns null if it cannot be resolved yet. */
  async _getCommandRoomId() {
    if (this.commandRoomId) return this.commandRoomId;
    try {
      this.commandRoomId = await this.matrix.resolveAlias(this.commandRoomAlias);
    } catch (err) {
      this.logger.warn?.(`[soundboard] Cannot resolve ${this.commandRoomAlias}: ${err.message}`);
    }
    return this.commandRoomId;
  }

  /**
   * Process a single `/sync` payload:
   *  - Auto-join invited rooms (`rooms.invite`)
   *  - Handle `!sb` messages, but only from the unencrypted #clips room, when `processTimeline`
   *
   * Commands never block the sync loop: `play` starts a background playback (see `handleCommand`).
   *
   * @param {object} syncData
   * @param {object} [opts]
   * @param {boolean} [opts.processTimeline=true]
   */
  async handleSyncResponse(syncData, { processTimeline = true } = {}) {
    if (!syncData || typeof syncData !== 'object') return;
    const rooms = syncData.rooms || {};

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

    const joined = rooms.join || {};
    const commandRoomId = Object.keys(joined).length ? await this._getCommandRoomId() : null;
    const events = (commandRoomId && joined[commandRoomId]?.timeline?.events) || [];
    for (const ev of events) {
      if (!ev || ev.type !== 'm.room.message') continue;
      if (ev.sender === this.matrix.userId) continue;
      if (ev.content?.msgtype !== 'm.text') continue;
      const cmd = parseCommand(ev.content?.body);
      if (!cmd) continue;
      try {
        await this.handleCommand(commandRoomId, cmd);
      } catch (err) {
        this.logger.error?.(`[soundboard] Error handling command: ${err.message}`);
      }
    }
  }

  /**
   * Execute a parsed `!sb` command issued in `replyRoomId` (#clips). Returns as soon as the
   * command is acknowledged; playback runs in the background (await `whenIdle()` in tests).
   *
   * @param {string} replyRoomId
   * @param {{ action: 'list' | 'play' | 'stop' | 'help', clip?: string, room?: string, error?: string }} cmd
   */
  async handleCommand(replyRoomId, cmd) {
    const say = (text) => this.matrix.sendNotice(replyRoomId, text);

    if (cmd.action === 'help') {
      await say(`${cmd.error}. Commands: !sb list | !sb play <clip> [in <room>] | !sb stop [in <room>]`);
      return;
    }

    if (cmd.action === 'list') {
      const names = this.clips.list();
      await say(
        names.length > 0
          ? `Available clips (${names.length}): ${names.join(', ')}`
          : 'No clips found in /clips.'
      );
      return;
    }

    if (cmd.action === 'stop') {
      let targets = [...this.playbacks.keys()];
      if (cmd.room) {
        const candidates = await this._listVoiceCandidates(replyRoomId);
        const res = resolveVoiceRoom({
          requested: cmd.room,
          candidates: candidates.map((c) => ({ ...c, activeCall: true })),
        });
        if (!('roomId' in res)) {
          await say(`No voice room matches "${cmd.room}".`);
          return;
        }
        targets = targets.filter((id) => id === res.roomId);
      }
      if (targets.length === 0) {
        await say('Nothing is playing.');
        return;
      }
      for (const id of targets) this._stopPlayback(id);
      await say('Stopped playback.');
      return;
    }

    if (cmd.action === 'play') {
      const filePath = this.clips.resolve(cmd.clip);
      if (!filePath) {
        const names = this.clips.list();
        const hint = names.length > 0 ? ` Available: ${names.join(', ')}` : '';
        await say(`Unknown clip "${cmd.clip}".${hint}`);
        return;
      }

      const candidates = await this._listVoiceCandidates(replyRoomId);
      const res = resolveVoiceRoom({ requested: cmd.room, candidates });
      if (!('roomId' in res)) {
        await say(this._describeResolveFailure(res, cmd.room));
        return;
      }
      this._startPlayback(res.roomId, filePath, replyRoomId);
    }
  }

  _describeResolveFailure(res, requested) {
    const names = res.options.map((c) => c.names[0] || c.roomId).join(', ');
    if (res.error === 'unknown') return `No voice room matches "${requested}".`;
    if (res.error === 'no-active-call') {
      return requested
        ? `No active voice call in "${requested}". Join the call first, then run !sb play.`
        : 'No active voice call in any room. Join a call first, then run !sb play <clip> [in <room>].';
    }
    return `Which room? Several match (${names}). Use !sb play <clip> in <room>.`;
  }

  /**
   * Rooms in the same Space as #clips (via `m.space.parent` -> `m.space.child`), with their
   * display names and whether a human has an active MatrixRTC membership. Rooms the bot cannot
   * read (not joined) are skipped.
   *
   * @param {string} commandRoomId
   * @returns {Promise<Array<{ roomId: string, names: string[], activeCall: boolean }>>}
   */
  async _listVoiceCandidates(commandRoomId) {
    const own = await this.matrix.getRoomState(commandRoomId);
    const parents = own
      .filter((e) => e.type === 'm.space.parent' && Array.isArray(e.content?.via) && e.content.via.length)
      .map((e) => e.state_key);
    const childIds = new Set();
    for (const parent of parents) {
      try {
        const st = await this.matrix.getRoomState(parent);
        for (const e of st) {
          if (e.type === 'm.space.child' && Array.isArray(e.content?.via) && e.content.via.length) {
            childIds.add(e.state_key);
          }
        }
      } catch (err) {
        this.logger.warn?.(`[soundboard] Cannot read space ${parent}: ${err.message}`);
      }
    }
    childIds.delete(commandRoomId);
    for (const p of parents) childIds.delete(p);

    const out = await Promise.all(
      [...childIds].map(async (roomId) => {
        try {
          const st = await this.matrix.getRoomState(roomId);
          const names = [];
          for (const e of st) {
            if (e.type === 'm.room.name' && e.content?.name) names.unshift(e.content.name);
            if (e.type === 'm.room.canonical_alias') {
              if (e.content?.alias) names.push(e.content.alias);
              if (Array.isArray(e.content?.alt_aliases)) names.push(...e.content.alt_aliases);
            }
          }
          const members = findActiveCallMemberships(st, { excludeUserId: this.matrix.userId });
          return { roomId, names, activeCall: members.length > 0 };
        } catch {
          return null;
        }
      })
    );
    return out.filter(Boolean);
  }

  /**
   * Start (or preempt with) a background playback in `voiceRoomId`. At most one runs per room:
   * a new play aborts the previous one, and the new run begins only after it has unwound.
   *
   * @returns {Promise<void>} resolves when this playback ends (never rejects)
   */
  _startPlayback(voiceRoomId, filePath, replyRoomId) {
    const prev = this.playbacks.get(voiceRoomId);
    if (prev) prev.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;

    const promise = (async () => {
      await prev?.promise;
      try {
        if (signal.aborted) return;
        const pcm = await this.decodeClip(filePath, { signal });
        if (signal.aborted) return;
        const session = await this._ensureRoomSession(voiceRoomId, signal, replyRoomId);
        if (signal.aborted) return;
        await session.playPcm(pcm, { signal });
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return;
        this.logger.error?.(`[soundboard] Playback failed in ${voiceRoomId}: ${err.message}`);
        await this.matrix.sendNotice(replyRoomId, `Playback failed: ${err.message}`).catch(() => {});
      } finally {
        if (this.playbacks.get(voiceRoomId)?.controller === controller) {
          this.playbacks.delete(voiceRoomId);
        }
      }
    })();

    this.playbacks.set(voiceRoomId, { controller, promise });
    return promise;
  }

  _stopPlayback(voiceRoomId) {
    this.playbacks.get(voiceRoomId)?.controller.abort();
    this.sessions.get(voiceRoomId)?.stopPlayback();
  }

  /** Resolve once every in-flight playback has finished (used by tests and shutdown). */
  async whenIdle() {
    while (this.playbacks.size > 0) {
      await Promise.all([...this.playbacks.values()].map((p) => p.promise));
    }
  }

  /**
   * Ensure the bot has joined the active MatrixRTC call in `roomId` and is connected to LiveKit.
   *
   * The `room` sent to lk-jwt-service /sfu/get is always the Matrix room ID: v0.4.4 hashes it
   * (sha256 of ["<room>","m.call#ROOM"], unpadded base64) into the LiveKit room name, and the
   * `livekit_alias` in call.member events is the Matrix room ID too
   * (element-hq/lk-jwt-service @ v0.4.4 main.go, LegacySFURequest + comment above `slotId`).
   *
   * @param {string} roomId
   * @param {AbortSignal} [signal]
   * @param {string} [replyRoomId]  where to report an unexpected SFU disconnect
   * @returns {Promise<RoomCallSession>}
   */
  async _ensureRoomSession(roomId, signal, replyRoomId) {
    const existing = this.sessions.get(roomId);
    if (existing && existing.connected) return existing;

    const stateEvents = await this.matrix.getRoomState(roomId);
    const oldest = findActiveCallMemberships(stateEvents, { excludeUserId: this.matrix.userId })[0];
    const livekitServiceUrl = oldest?.livekitServiceUrl || `https://${this.rtcFqdn}/livekit/jwt`;

    const openIdToken = await this.matrix.requestOpenIdToken();
    const { url, jwt } = await fetchLiveKitJwt({
      rtcFqdn: this.rtcFqdn,
      roomId,
      openIdToken,
      deviceId: this.matrix.deviceId,
      fetchImpl: this.fetchImpl,
    });
    if (signal?.aborted) throw abortError();

    const createdTs = Date.now();
    const memberContent = (now) =>
      buildCallMemberContent({
        deviceId: this.matrix.deviceId,
        roomId,
        livekitServiceUrl,
        callId: oldest?.callId ?? '',
        createdTs, // preserved across refreshes so oldest_membership ordering is stable
        expiresMs: now - createdTs + this.memberExpiresMs,
      });
    await this.matrix.putCallMemberState(roomId, memberContent(Date.now()));

    const session = new RoomCallSession({
      roomId,
      idleTimeoutMs: this.idleTimeoutMs,
      rtcFactory: this.rtcFactory,
      refreshMs: Math.floor(this.memberExpiresMs / 2),
      // Extend `expires` (keeping created_ts) before it lapses, like matrix-js-sdk's
      // MembershipManager UpdateExpiry action (src/matrixrtc/MembershipManager.ts).
      onRefresh: async () => {
        try {
          await this.matrix.putCallMemberState(roomId, memberContent(Date.now()));
        } catch (err) {
          this.logger.warn?.(`[soundboard] call.member refresh failed in ${roomId}: ${err.message}`);
        }
      },
      onDisconnected: (reason) => {
        this.logger.warn?.(`[soundboard] SFU disconnected in ${roomId} (${reason ?? 'unknown'})`);
        this.playbacks.get(roomId)?.controller.abort();
        if (replyRoomId) {
          this.matrix
            .sendNotice(replyRoomId, 'Lost the voice connection; run !sb play again to rejoin.')
            .catch(() => {});
        }
      },
      onLeave: async () => {
        if (this.sessions.get(roomId) === session) this.sessions.delete(roomId);
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
   * Stop the bot: abort all playbacks (killing ffmpeg), disconnect from every call and clear
   * the MatrixRTC call.member state.
   */
  async shutdown() {
    this._running = false;
    for (const pb of this.playbacks.values()) pb.controller.abort();
    await this.whenIdle();
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of activeSessions) {
      await session.disconnect();
    }
  }
}
