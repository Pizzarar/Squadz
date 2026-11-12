// lk-jwt-service v0.4.4 legacy /sfu/get. `room` MUST be the Matrix roomId. Same body as
// bots/soundboard fetchLiveKitJwt (keep in sync); the service URL comes from well-known.
export function buildSfuBody({ roomId, openIdToken, deviceId }) {
  if (!roomId || !openIdToken || !deviceId) throw new Error('roomId, openIdToken and deviceId are required');
  if (!roomId.startsWith('!')) throw new Error('sfu/get room must be a Matrix roomId, not an alias');
  return { room: roomId, openid_token: openIdToken, device_id: deviceId };
}

export async function fetchSfuToken({ livekitServiceUrl, roomId, openIdToken, deviceId, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${livekitServiceUrl.replace(/\/+$/, '')}/sfu/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSfuBody({ roomId, openIdToken, deviceId })),
  });
  if (!res.ok) throw new Error(`lk-jwt-service ${res.status}: ${await res.text().catch(() => '')}`);
  const d = await res.json();
  if (!d || typeof d.url !== 'string' || typeof d.jwt !== 'string') throw new Error('lk-jwt-service returned invalid {url, jwt}');
  return { url: d.url, jwt: d.jwt };
}
