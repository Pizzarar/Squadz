// scripts/e2e/lib.mjs
//
// Shared helpers for the real-stack e2e phases. Pure helpers (token minting, LiveKit room-name
// derivation, bootstrap-summary parsing) are unit-tested in test/lib.test.mjs; the rest talks to
// the live stack and can only be proven by CI.

import { createHmac, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMatrixClient } from "../lib/matrix.mjs";

export const E2E_DIR = path.resolve(process.cwd(), ".e2e");
export const STATE_FILE = path.join(E2E_DIR, "state.json");

export function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

/** Resolve the e2e configuration from the environment (the workflow exports .env into it). */
export function loadConfig(env = process.env) {
  requireEnv(env, [
    "CHAT_FQDN",
    "RTC_FQDN",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "TUWUNEL_REGISTRATION_TOKEN",
    "SQUADZ_ADMIN_USER",
    "SQUADZ_ADMIN_PASSWORD",
    "SOUNDBOARD_MATRIX_USER",
    "SOUNDBOARD_MATRIX_PASSWORD",
  ]);
  return {
    chatFqdn: env.CHAT_FQDN,
    rtcFqdn: env.RTC_FQDN,
    chatUrl: `https://${env.CHAT_FQDN}`,
    rtcUrl: `https://${env.RTC_FQDN}`,
    lkKey: env.LIVEKIT_API_KEY,
    lkSecret: env.LIVEKIT_API_SECRET,
    regToken: env.TUWUNEL_REGISTRATION_TOKEN,
    adminUser: env.SQUADZ_ADMIN_USER,
    adminPassword: env.SQUADZ_ADMIN_PASSWORD,
    botUser: env.SOUNDBOARD_MATRIX_USER,
    botPassword: env.SOUNDBOARD_MATRIX_PASSWORD,
  };
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(patch) {
  mkdirSync(E2E_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// Tiny test harness: numbered steps, fail fast with a readable message.
// ---------------------------------------------------------------------------

export function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT: ${message}`);
}

export function assertEq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`ASSERT: ${what}: expected ${e}, got ${a}`);
}

export async function step(name, fn) {
  process.stdout.write(`\n=== ${name}\n`);
  try {
    const out = await fn();
    process.stdout.write(`[PASS] ${name}\n`);
    return out;
  } catch (err) {
    process.stdout.write(`[FAIL] ${name}: ${err.stack || err.message}\n`);
    throw err;
  }
}

/** Run `main` and exit non-zero on failure (step() already printed the reason). */
export function run(main) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`e2e failed: ${err.message}\n`);
      process.exit(1);
    },
  );
}

/** Poll `fn` until it returns a truthy value (returned) or `timeoutMs` elapses (throws). */
export async function waitFor(label, fn, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const start = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// LiveKit (pure helpers)
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Mint an HS256 LiveKit access token (JWT) with the given video grant. */
export function mintLivekitToken(apiKey, apiSecret, video, { identity = "e2e-admin", ttlSec = 300, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: apiKey, sub: identity, nbf: iat - 5, iat, exp: iat + ttlSec, video };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", apiSecret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

/** Decode (without verifying) a JWT payload. */
export function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("not a JWT (expected 3 dot-separated parts)");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

/**
 * LiveKit room name lk-jwt-service v0.4.4 derives for a Matrix room: unpadded base64 of
 * sha256(JSON(["<roomId>", "m.call#ROOM"])) (element-hq/lk-jwt-service main.go, handle_legacy).
 */
export function lkRoomName(matrixRoomId) {
  return createHash("sha256")
    .update(JSON.stringify([matrixRoomId, "m.call#ROOM"]))
    .digest("base64")
    .replace(/=+$/, "");
}

/** Call a LiveKit RoomService twirp method through Caddy (`/livekit/sfu` prefix is stripped). */
export async function lkTwirp(cfg, method, body, grant) {
  const token = mintLivekitToken(cfg.lkKey, cfg.lkSecret, grant);
  const res = await fetch(`${cfg.rtcUrl}/livekit/sfu/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LiveKit ${method} -> HTTP ${res.status}: ${text}`);
  return JSON.parse(text || "{}");
}

export async function lkListParticipants(cfg, roomName) {
  const out = await lkTwirp(cfg, "ListParticipants", { room: roomName }, { roomAdmin: true, room: roomName });
  return out.participants ?? [];
}

/**
 * Open the LiveKit signalling WebSocket with `jwt` (what a client SDK does first) and resolve
 * once the server sends its first frame (a protobuf JoinResponse). Caller closes `ws`.
 */
export function lkSignalJoin(sfuUrl, jwt, { timeoutMs = 15_000 } = {}) {
  const base = sfuUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const url = `${base}/rtc?access_token=${encodeURIComponent(jwt)}&auto_subscribe=0&sdk=js&version=2.5.0&protocol=15`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`LiveKit signalling join timed out after ${timeoutMs}ms (${base}/rtc)`));
    }, timeoutMs);
    ws.addEventListener("message", (ev) => {
      clearTimeout(timer);
      const bytes = typeof ev.data === "string" ? ev.data.length : ev.data.byteLength;
      resolve({ ws, firstFrameBytes: bytes });
    });
    ws.addEventListener("error", (ev) => {
      clearTimeout(timer);
      reject(new Error(`LiveKit signalling WebSocket error: ${ev.message || "connection failed / rejected"}`));
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      reject(new Error(`LiveKit signalling WebSocket closed before join response (code ${ev.code})`));
    });
  });
}

// ---------------------------------------------------------------------------
// bootstrap.mjs output
// ---------------------------------------------------------------------------

/** Extract the JSON summary scripts/bootstrap.mjs prints after "Done.". */
export function parseBootstrapSummary(stdout) {
  const marker = "\nDone.\n";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) throw new Error("bootstrap output has no 'Done.' marker");
  return JSON.parse(stdout.slice(idx + marker.length));
}

// ---------------------------------------------------------------------------
// Matrix helpers
// ---------------------------------------------------------------------------

export function newClient(cfg) {
  return createMatrixClient(cfg.chatUrl);
}

export async function loggedInClient(cfg, user, password) {
  const client = newClient(cfg);
  const res = await client.login(user, password);
  client.token = res.access_token;
  return { client, userId: res.user_id, deviceId: res.device_id };
}

/** Register (or log in if it already exists) and return a ready client. */
export async function registerOrLogin(cfg, user, password) {
  const client = newClient(cfg);
  let res;
  try {
    res = await client.register(user, password, cfg.regToken);
  } catch (err) {
    if (err.errcode !== "M_USER_IN_USE") throw err;
    res = await client.login(user, password);
  }
  if (!res.access_token) res = await client.login(user, password);
  client.token = res.access_token;
  return { client, userId: res.user_id, deviceId: res.device_id };
}

export async function joinRoom(client, roomId) {
  return client.request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, { body: {} });
}

export async function sendText(client, roomId, body) {
  const txn = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return client.request(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    { body: { msgtype: "m.text", body } },
  );
}
