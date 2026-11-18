// Matrix + well-known helpers. Pure: fetch injected. The call.member shape mirrors
// bots/soundboard/src/matrixrtc.js (keep in sync).
export const CALL_MEMBER_EVENT_TYPE = 'org.matrix.msc3401.call.member';
export const DEFAULT_EXPIRES_MS = 4 * 60 * 60 * 1000;
export const RTC_FOCI_KEY = 'org.matrix.msc4143.rtc_foci';
export const DEFAULT_ROOMS = ['game-night', 'lounge'];

const trim = (u) => u.replace(/\/+$/, '');

export function buildCallMemberStateKey(userId, deviceId, membershipId = 'm.call') {
  if (!userId || !deviceId) throw new Error('userId and deviceId are required for call.member state_key');
  return `_${userId}_${deviceId}_${membershipId}`;
}

export function buildCallMemberContent({ deviceId, roomId, livekitServiceUrl, callId = '', scope = 'm.room', expiresMs = DEFAULT_EXPIRES_MS, createdTs = Date.now() }) {
  if (!deviceId || !roomId || !livekitServiceUrl) throw new Error('deviceId, roomId, and livekitServiceUrl are required');
  return {
    application: 'm.call', call_id: callId, scope, device_id: deviceId, expires: expiresMs, created_ts: createdTs,
    focus_active: { type: 'livekit', focus_selection: 'oldest_membership' },
    foci_preferred: [{ type: 'livekit', livekit_service_url: livekitServiceUrl, livekit_alias: roomId }],
  };
}

/** server_name part of a user id like @me:chat.example.com */
export function serverNameFromUserId(userId) {
  const i = userId.indexOf(':');
  return i < 0 ? '' : userId.slice(i + 1);
}

/** Default room aliases: #game-night first, then #lounge. */
export function defaultRoomAliases(serverName) {
  return DEFAULT_ROOMS.map((s) => `#${s}:${serverName}`);
}

/** livekit_service_url from a parsed /.well-known/matrix/client doc. */
export function pickLivekitServiceUrl(wellKnown) {
  const foci = wellKnown && wellKnown[RTC_FOCI_KEY];
  const f = Array.isArray(foci) ? foci.find((x) => x && x.type === 'livekit' && typeof x.livekit_service_url === 'string') : null;
  if (!f) throw new Error(`well-known has no ${RTC_FOCI_KEY} livekit entry`);
  return trim(f.livekit_service_url);
}

export async function resolveLivekitServiceUrl(homeserver, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${trim(homeserver)}/.well-known/matrix/client`);
  if (!res.ok) throw new Error(`well-known fetch failed: ${res.status}`);
  return pickLivekitServiceUrl(await res.json());
}

async function mx(fetchImpl, homeserver, path, { method = 'GET', token, body, keepalive } = {}) {
  const res = await fetchImpl(`${trim(homeserver)}/_matrix/client/v3${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(keepalive ? { keepalive: true } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.errcode = data.errcode;
    throw e;
  }
  return data;
}

export async function login(homeserver, user, password, fetchImpl = globalThis.fetch) {
  const d = await mx(fetchImpl, homeserver, '/login', {
    method: 'POST',
    body: { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, initial_device_display_name: 'Squadz Go-Live' },
  });
  return { accessToken: d.access_token, userId: d.user_id, deviceId: d.device_id };
}

/** A roomId passes through; an alias is resolved via the directory. */
export async function resolveRoom(homeserver, roomOrAlias, token, fetchImpl = globalThis.fetch) {
  if (roomOrAlias.startsWith('!')) return roomOrAlias;
  if (!roomOrAlias.startsWith('#')) throw new Error('room must start with ! (room id) or # (alias)');
  const d = await mx(fetchImpl, homeserver, `/directory/room/${encodeURIComponent(roomOrAlias)}`, { token });
  return d.room_id;
}

export function openidToken(homeserver, userId, token, fetchImpl = globalThis.fetch) {
  return mx(fetchImpl, homeserver, `/user/${encodeURIComponent(userId)}/openid/request_token`, { method: 'POST', token, body: {} });
}

export function friendlyStateError(err) {
  if (err && (err.status === 403 || err.errcode === 'M_FORBIDDEN')) {
    return 'You do not have permission to start a call in this room (your power level is too low to send call.member). Ask an admin to raise it, or pick another room.';
  }
  return err && err.message ? err.message : String(err);
}

async function putState(homeserver, roomId, userId, deviceId, token, content, fetchImpl, keepalive = false) {
  const key = buildCallMemberStateKey(userId, deviceId);
  try {
    await mx(fetchImpl, homeserver, `/rooms/${encodeURIComponent(roomId)}/state/${CALL_MEMBER_EVENT_TYPE}/${encodeURIComponent(key)}`, { method: 'PUT', token, body: content, keepalive });
  } catch (e) {
    throw new Error(friendlyStateError(e));
  }
}

export function sendCallMember({ homeserver, roomId, userId, deviceId, token, livekitServiceUrl, fetchImpl = globalThis.fetch, createdTs }) {
  return putState(homeserver, roomId, userId, deviceId, token, buildCallMemberContent({ deviceId, roomId, livekitServiceUrl, createdTs }), fetchImpl);
}

export function clearCallMember({ homeserver, roomId, userId, deviceId, token, fetchImpl = globalThis.fetch, keepalive = false }) {
  return putState(homeserver, roomId, userId, deviceId, token, {}, fetchImpl, keepalive);
}

/** Room id/alias from a `?room=` query string (e.g. location.search), or '' if absent/invalid. */
export function roomFromSearch(search) {
  const v = (new URLSearchParams(search || '').get('room') || '').trim();
  return /^[!#][^\s]+:[^\s]+$/.test(v) ? v : '';
}

/**
 * Prefill the lobby room pickers: select a matching option, else put it in the custom field.
 * `sel` is a <select>-like ({options, value}); `custom` an <input>-like ({value}).
 */
export function prefillRoom(room, sel, custom) {
  if (!room) return;
  const hit = Array.from(sel.options).find((o) => o.value === room);
  if (hit) { sel.value = room; custom.value = ''; } else { custom.value = room; }
}
