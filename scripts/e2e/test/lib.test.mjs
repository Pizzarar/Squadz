import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { decodeJwt, lkRoomName, loadConfig, mintLivekitToken, parseBootstrapSummary, waitFor } from "../lib.mjs";

test("mintLivekitToken produces a verifiable HS256 JWT with the grant", () => {
  const tok = mintLivekitToken("devkey", "s3cret", { roomList: true }, { now: 1_700_000_000_000, ttlSec: 60 });
  const [h, p, s] = tok.split(".");
  const expected = createHmac("sha256", "s3cret").update(`${h}.${p}`).digest("base64url");
  assert.equal(s, expected);
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "HS256", typ: "JWT" });
  const claims = decodeJwt(tok);
  assert.equal(claims.iss, "devkey");
  assert.equal(claims.exp, 1_700_000_060);
  assert.deepEqual(claims.video, { roomList: true });
});

test("decodeJwt rejects non-JWTs", () => {
  assert.throws(() => decodeJwt("abc"), /not a JWT/);
});

test("lkRoomName matches lk-jwt-service v0.4.4 derivation (unpadded b64 sha256 of JSON [room, slot])", () => {
  // Independent value: printf '["!abc:chat.squadz.test","m.call#ROOM"]' | openssl dgst -sha256 -binary | openssl base64 -A | tr -d =
  assert.equal(lkRoomName("!abc:chat.squadz.test"), "UUeqQhEYZ0tLqejVJU3c62Hho/KigzptwCBVXU1dp2M");
  assert.notEqual(lkRoomName("!abd:chat.squadz.test"), lkRoomName("!abc:chat.squadz.test"));
});

test("parseBootstrapSummary reads the JSON after 'Done.'", () => {
  const out = 'Homeserver: x\n  admin: y\n\nDone.\n{\n  "spaceId": "!s:x",\n  "createdRooms": 6\n}\n';
  assert.deepEqual(parseBootstrapSummary(out), { spaceId: "!s:x", createdRooms: 6 });
  assert.throws(() => parseBootstrapSummary("nothing"), /Done/);
});

test("loadConfig lists every missing variable", () => {
  assert.throws(() => loadConfig({ CHAT_FQDN: "a" }), /RTC_FQDN.*LIVEKIT_API_KEY/s);
});

test("waitFor resolves when the predicate turns truthy and times out otherwise", async () => {
  let n = 0;
  assert.equal(await waitFor("x", () => ++n >= 3 && "ok", { timeoutMs: 2000, intervalMs: 5 }), "ok");
  await assert.rejects(waitFor("never", () => false, { timeoutMs: 30, intervalMs: 5 }), /Timed out/);
});
