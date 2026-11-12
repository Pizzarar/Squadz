// Minimal Matrix Client-Server API wrapper using native `fetch`.
// Implements login, OpenID token request, /sync polling, room join, message send, and state read/write.
import { CALL_MEMBER_EVENT_TYPE, buildCallMemberStateKey } from './matrixrtc.js';

export class MatrixClient {
  /**
   * @param {object} opts
   * @param {string} opts.homeserverUrl   e.g. `https://${CHAT_FQDN}`
   * @param {string} [opts.userId]
   * @param {string} [opts.accessToken]
   * @param {string} [opts.deviceId]
   * @param {typeof fetch} [opts.fetchImpl=fetch]
   */
  constructor({ homeserverUrl, userId = null, accessToken = null, deviceId = null, fetchImpl = globalThis.fetch }) {
    if (!homeserverUrl) throw new Error('homeserverUrl is required');
    this.homeserverUrl = homeserverUrl.startsWith('http://') || homeserverUrl.startsWith('https://')
      ? homeserverUrl.replace(/\/+$/, '')
      : `https://${homeserverUrl.replace(/\/+$/, '')}`;
    this.userId = userId;
    this.accessToken = accessToken;
    this.deviceId = deviceId;
    this.fetchImpl = fetchImpl;
    this._txnCounter = 0;
  }

  /**
   * Perform an authenticated or unauthenticated Matrix C-S API request.
   */
  async _request(method, path, { query, body, auth = true } = {}) {
    const url = new URL(`${this.homeserverUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers = { Accept: 'application/json' };
    if (auth && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body: payload });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`Matrix ${method} ${path} failed (${res.status}): ${errText}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * Log in with `m.login.password` and store `userId`, `accessToken`, and `deviceId`.
   *
   * @param {string} user      Matrix username or full MXID (`@soundboard:chat.example.com`)
   * @param {string} password
   * @param {string} [deviceId='SOUNDBOARD']
   */
  async login(user, password, deviceId = 'SOUNDBOARD') {
    const data = await this._request('POST', '/_matrix/client/v3/login', {
      auth: false,
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
        device_id: deviceId,
        initial_device_display_name: 'Squadz Soundboard Bot',
      },
    });
    this.userId = data.user_id;
    this.accessToken = data.access_token;
    this.deviceId = data.device_id || deviceId;
    return {
      userId: this.userId,
      accessToken: this.accessToken,
      deviceId: this.deviceId,
    };
  }

  /**
   * Request an OpenID token from the Matrix homeserver for `lk-jwt-service` verification:
   * `POST /_matrix/client/v3/user/{userId}/openid/request_token`
   */
  async requestOpenIdToken() {
    if (!this.userId) throw new Error('Must be logged in before requesting OpenID token');
    const encodedUser = encodeURIComponent(this.userId);
    return this._request('POST', `/_matrix/client/v3/user/${encodedUser}/openid/request_token`, {
      body: {},
    });
  }

  /**
   * Poll `/_matrix/client/v3/sync`.
   */
  async sync({ since, timeout = 30000 } = {}) {
    return this._request('GET', '/_matrix/client/v3/sync', {
      query: { since, timeout },
    });
  }

  /**
   * Join a room by ID or alias.
   */
  async joinRoom(roomIdOrAlias) {
    const encoded = encodeURIComponent(roomIdOrAlias);
    return this._request('POST', `/_matrix/client/v3/join/${encoded}`, { body: {} });
  }

  /**
   * Send a plain-text `m.notice` message to `roomId`.
   */
  async sendNotice(roomId, text) {
    const encodedRoom = encodeURIComponent(roomId);
    const txnId = `sb_${Date.now()}_${++this._txnCounter}`;
    return this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodedRoom}/send/m.room.message/${txnId}`,
      {
        body: { msgtype: 'm.notice', body: text },
      }
    );
  }

  /**
   * Fetch all current state events in `roomId`.
   */
  async getRoomState(roomId) {
    const encodedRoom = encodeURIComponent(roomId);
    return this._request('GET', `/_matrix/client/v3/rooms/${encodedRoom}/state`);
  }

  /**
   * Put a `org.matrix.msc3401.call.member` state event for this bot device.
   */
  async putCallMemberState(roomId, content, stateKey = buildCallMemberStateKey(this.userId, this.deviceId)) {
    const encodedRoom = encodeURIComponent(roomId);
    const encodedType = encodeURIComponent(CALL_MEMBER_EVENT_TYPE);
    const encodedKey = encodeURIComponent(stateKey);
    return this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodedRoom}/state/${encodedType}/${encodedKey}`,
      { body: content }
    );
  }
}
