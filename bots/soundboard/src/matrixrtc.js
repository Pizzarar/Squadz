// MatrixRTC protocol layer (MSC3401 / MSC4143 / MSC4195) and lk-jwt-service auth flow.
// Kept isolated in one file so event shape or focus discovery updates stay in one place.
//
// References:
//   - MSC4143 (MatrixRTC): https://github.com/matrix-org/matrix-spec-proposals/pull/4143
//   - MSC3401 (Group VoIP signalling): https://github.com/matrix-org/matrix-spec-proposals/pull/3401
//   - MSC4195 (LiveKit RTC transport): https://github.com/matrix-org/matrix-spec-proposals/pull/4195
//   - matrix-js-sdk CallMembership: src/matrixrtc/CallMembership.ts
//   - element-hq/lk-jwt-service: POST /sfu/get

export const CALL_MEMBER_EVENT_TYPE = 'org.matrix.msc3401.call.member';
export const DEFAULT_EXPIRES_MS = 4 * 60 * 60 * 1000; // 4 hours, matching matrix-js-sdk default

/**
 * Build the state_key used by MSC4143 / matrix-js-sdk per-device session memberships:
 * `_<userId>_<deviceId>_<membershipId>`
 *
 * @param {string} userId
 * @param {string} deviceId
 * @param {string} [membershipId='m.call']
 * @returns {string}
 */
export function buildCallMemberStateKey(userId, deviceId, membershipId = 'm.call') {
  if (!userId || !deviceId) {
    throw new Error('userId and deviceId are required for call.member state_key');
  }
  return `_${userId}_${deviceId}_${membershipId}`;
}

/**
 * Build the MSC4143 / MSC3401 `org.matrix.msc3401.call.member` state event content
 * used by Element Call and Element X for LiveKit-backed room calls.
 *
 * @param {object} params
 * @param {string} params.deviceId
 * @param {string} params.roomId
 * @param {string} params.livekitServiceUrl  e.g. `https://${RTC_FQDN}/livekit/jwt`
 * @param {string} [params.callId='']
 * @param {string} [params.scope='m.room']
 * @param {number} [params.expiresMs=DEFAULT_EXPIRES_MS]
 * @param {number} [params.createdTs]
 * @returns {object}
 */
export function buildCallMemberContent({
  deviceId,
  roomId,
  livekitServiceUrl,
  callId = '',
  scope = 'm.room',
  expiresMs = DEFAULT_EXPIRES_MS,
  createdTs = Date.now(),
}) {
  if (!deviceId || !roomId || !livekitServiceUrl) {
    throw new Error('deviceId, roomId, and livekitServiceUrl are required');
  }
  return {
    application: 'm.call',
    call_id: callId,
    scope,
    device_id: deviceId,
    expires: expiresMs,
    created_ts: createdTs,
    focus_active: {
      type: 'livekit',
      focus_selection: 'oldest_membership',
    },
    foci_preferred: [
      {
        type: 'livekit',
        livekit_service_url: livekitServiceUrl,
        livekit_alias: roomId,
      },
    ],
  };
}

/**
 * Build the empty state event content `{}` posted on leave to clear a call membership.
 * @returns {Record<string, never>}
 */
export function buildLeaveCallMemberContent() {
  return {};
}

/**
 * Extract active `m.call` memberships from a list of room state events.
 * Supports both modern per-device session events (MSC4143) and legacy `memberships: [...]`
 * arrays (MSC3401), ignoring expired entries and the bot's own userId if `excludeUserId` is given.
 *
 * @param {Array<object>} stateEvents
 * @param {object} [options]
 * @param {number} [options.now=Date.now()]
 * @param {string} [options.excludeUserId]
 * @returns {Array<{ userId: string, deviceId: string, callId: string, livekitAlias: string | null, livekitServiceUrl: string | null, createdTs: number }>}
 */
export function findActiveCallMemberships(stateEvents, { now = Date.now(), excludeUserId } = {}) {
  if (!Array.isArray(stateEvents)) return [];
  const active = [];

  for (const ev of stateEvents) {
    if (!ev || ev.type !== CALL_MEMBER_EVENT_TYPE) continue;
    const sender = ev.sender;
    if (!sender || (excludeUserId && sender === excludeUserId)) continue;
    const content = ev.content;
    if (!content || typeof content !== 'object') continue;

    // Legacy MSC3401 format wraps entries in `content.memberships` array;
    // Modern MSC4143 format puts session fields at top-level `content`.
    const entries = Array.isArray(content.memberships) ? content.memberships : [content];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.application !== 'm.call') continue;
      if (!entry.device_id || typeof entry.device_id !== 'string') continue;

      const baseTs =
        typeof entry.created_ts === 'number'
          ? entry.created_ts
          : typeof ev.origin_server_ts === 'number'
            ? ev.origin_server_ts
            : null;

      if (typeof entry.expires === 'number' && baseTs !== null) {
        if (baseTs + entry.expires <= now) continue;
      }

      const foci = Array.isArray(entry.foci_preferred) ? entry.foci_preferred : [];
      const lkFocus = foci.find((f) => f && f.type === 'livekit') || null;

      active.push({
        userId: sender,
        deviceId: entry.device_id,
        callId: typeof entry.call_id === 'string' ? entry.call_id : '',
        livekitAlias: lkFocus && typeof lkFocus.livekit_alias === 'string' ? lkFocus.livekit_alias : null,
        livekitServiceUrl:
          lkFocus && typeof lkFocus.livekit_service_url === 'string' ? lkFocus.livekit_service_url : null,
        createdTs: baseTs ?? 0,
      });
    }
  }

  // Sort oldest-first so `active[0]` corresponds to `oldest_membership` focus selection.
  active.sort((a, b) => a.createdTs - b.createdTs);
  return active;
}

/**
 * Determine whether a room currently has at least one active non-bot participant in a call.
 *
 * @param {Array<object>} stateEvents
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {string} [options.excludeUserId]
 * @returns {boolean}
 */
export function hasActiveCall(stateEvents, options) {
  return findActiveCallMemberships(stateEvents, options).length > 0;
}

/**
 * Exchange a Matrix OpenID token for a LiveKit connection URL and JWT via `lk-jwt-service`
 * per the P1 Contract:
 *   `POST https://${RTC_FQDN}/livekit/jwt/sfu/get` with `{ room, openid_token, device_id }`
 *   -> `{ url, jwt }`
 *
 * @param {object} params
 * @param {string} params.rtcFqdn            e.g. `rtc.example.com` or full `https://rtc.example.com`
 * @param {string} params.roomId             Matrix room ID (`!abc:chat.example.com`)
 * @param {object} params.openIdToken        Matrix OpenID token object from `/openid/request_token`
 * @param {string} params.deviceId           Matrix device_id
 * @param {typeof fetch} [params.fetchImpl=fetch]
 * @returns {Promise<{ url: string, jwt: string }>}
 */
export async function fetchLiveKitJwt({
  rtcFqdn,
  roomId,
  openIdToken,
  deviceId,
  fetchImpl = globalThis.fetch,
}) {
  if (!rtcFqdn || !roomId || !openIdToken || !deviceId) {
    throw new Error('rtcFqdn, roomId, openIdToken, and deviceId are required');
  }
  const base = rtcFqdn.startsWith('http://') || rtcFqdn.startsWith('https://')
    ? rtcFqdn.replace(/\/+$/, '')
    : `https://${rtcFqdn.replace(/\/+$/, '')}`;
  const endpoint = `${base}/livekit/jwt/sfu/get`;

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: roomId,
      openid_token: openIdToken,
      device_id: deviceId,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`lk-jwt-service ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data || typeof data.url !== 'string' || typeof data.jwt !== 'string') {
    throw new Error('lk-jwt-service returned invalid {url, jwt} payload');
  }
  return { url: data.url, jwt: data.jwt };
}
