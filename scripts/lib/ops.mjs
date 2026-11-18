// scripts/lib/ops.mjs
//
// Logic behind `node scripts/squadz.mjs <cmd>`. Everything here is either pure
// or takes its I/O (Matrix client, DNS, sockets, docker) as an argument so it
// can be unit-tested against scripts/test/mock-homeserver.mjs and fakes.

import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { SPACE, ROOMS } from "./seed.mjs";
import { toUserId } from "./config.mjs";

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/** URL-safe random secret (base64url, no padding). */
export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Generate every secret `setup` is responsible for. */
export function generateSecrets() {
  return {
    LIVEKIT_API_KEY: `lk_${crypto.randomBytes(6).toString("hex")}`,
    LIVEKIT_API_SECRET: randomSecret(32), // 43 chars, > LiveKit's 32 char minimum
    TUWUNEL_REGISTRATION_TOKEN: randomSecret(24),
    SQUADZ_ADMIN_PASSWORD: randomSecret(18),
    SOUNDBOARD_MATRIX_PASSWORD: randomSecret(18),
  };
}

/** Parse a CGNAT/mesh IPv4 (100.64.0.0/10) out of arbitrary command output. */
export function parseMeshIp(text) {
  for (const m of String(text).matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const octets = m.slice(1).map(Number);
    if (octets.some((o) => o > 255)) continue;
    if (a === 100 && b >= 64 && b <= 127) return m[0];
  }
  return null;
}

/** Cheap hostname sanity check (no scheme, no path, at least one dot). */
export function isFqdn(s) {
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(s);
}

export function isMeshIp(s) {
  return parseMeshIp(s) === s;
}

/**
 * Validate the inputs `setup` needs. Returns a list of human-readable problems
 * (empty = OK).
 */
export function validateSetupInputs({ domain, cloudflareToken, meshIp, email }) {
  const problems = [];
  if (!domain || !isFqdn(domain)) problems.push(`domain "${domain ?? ""}" is not a valid domain (e.g. example.com)`);
  if (!cloudflareToken || cloudflareToken.length < 20) problems.push("Cloudflare API token looks too short");
  if (!meshIp || !isMeshIp(meshIp)) problems.push(`mesh IP "${meshIp ?? ""}" is not a 100.64.0.0/10 address`);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push(`email "${email}" is not valid`);
  return problems;
}

/**
 * Render a .env from .env.example text, replacing KEY=value lines in place so
 * comments and ordering are preserved. Keys missing from the template are
 * appended.
 *
 * @param {string} template contents of .env.example
 * @param {Record<string,string>} values
 */
export function renderEnv(template, values) {
  const seen = new Set();
  const lines = template.split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m && Object.hasOwn(values, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return lines.join("\n").replace(/\n*$/, "\n");
}

/** Build the full key/value set for a fresh .env. */
export function buildEnvValues({ domain, cloudflareToken, meshIp, email, adminUser, secrets }) {
  return {
    SQUADZ_DOMAIN: domain,
    CHAT_FQDN: `chat.${domain}`,
    RTC_FQDN: `rtc.${domain}`,
    MESH_IP: meshIp,
    ACME_EMAIL: email || `admin@${domain}`,
    CLOUDFLARE_API_TOKEN: cloudflareToken,
    SQUADZ_ADMIN_USER: adminUser || "admin",
    ...secrets,
  };
}

/** Which secrets the user must copy (shown once, deliberately). */
export const COPY_ONCE = ["SQUADZ_ADMIN_PASSWORD"];

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export const COMPOSE_SERVICES = ["caddy", "tuwunel", "livekit", "lk-jwt-service"];

const ok = (name, detail) => ({ name, ok: true, detail });
const fail = (name, detail, fix) => ({ name, ok: false, detail, fix });

export function checkDns(name, fqdn, meshIp, addrs) {
  const label = `DNS ${fqdn} -> ${meshIp}`;
  if (!addrs || addrs.length === 0) {
    return fail(label, "no A record", `Create a DNS-only A record ${fqdn} -> ${meshIp} in Cloudflare (docs/DEPLOY.md step 2).`);
  }
  if (!addrs.includes(meshIp)) {
    return fail(label, `resolves to ${addrs.join(", ")}`, `Edit the A record for ${fqdn} to ${meshIp}. If your router returns nothing, see DNS rebinding in docs/SETUP.md.`);
  }
  return ok(label, addrs.join(", "));
}

export function checkPort(meshIp, port, reachable) {
  const label = `port ${meshIp}:${port}/tcp listening`;
  return reachable
    ? ok(label, "connected")
    : fail(label, "connection refused or timed out", `Is the stack up (docker compose up -d) and is Tailscale up on this host owning ${meshIp}? Check firewall for ${port}/tcp.`);
}

/** @param {{authorized?: boolean, validTo?: string, error?: string}|null} cert */
export function checkTls(fqdn, cert, now = new Date()) {
  const label = `TLS cert ${fqdn}`;
  if (!cert) return fail(label, "no certificate presented", "Check `docker compose logs caddy` for ACME DNS-01 errors (Cloudflare token scope).");
  if (cert.error) return fail(label, cert.error, "Check `docker compose logs caddy`; the Cloudflare token needs Zone:DNS:Edit on the domain.");
  const expires = new Date(cert.validTo);
  const days = Math.floor((expires - now) / 86400000);
  if (Number.isNaN(days)) return fail(label, `unreadable expiry "${cert.validTo}"`, "Restart caddy and retry.");
  if (days < 0) return fail(label, `expired ${-days}d ago`, "docker compose restart caddy and read its logs.");
  if (cert.authorized === false) return fail(label, "certificate not trusted", "Caddy may still be on a staging/self-signed cert; check its logs for ACME errors.");
  if (days < 7) return fail(label, `expires in ${days}d`, "Caddy renews at 30d; check its logs for renewal failures.");
  return ok(label, `valid, ${days}d left`);
}

export function checkWellKnown(chatFqdn, rtcFqdn, doc) {
  const label = "/.well-known/matrix/client";
  if (!doc) return fail(label, "no JSON response", `curl https://${chatFqdn}/.well-known/matrix/client; check the caddy container and DNS.`);
  const problems = [];
  const base = doc["m.homeserver"]?.base_url;
  if (base !== `https://${chatFqdn}`) problems.push(`m.homeserver.base_url is ${JSON.stringify(base)}, want "https://${chatFqdn}"`);
  const foci = doc["org.matrix.msc4143.rtc_foci"];
  const want = `https://${rtcFqdn}/livekit/jwt`;
  const hit = Array.isArray(foci) && foci.some((f) => f?.type === "livekit" && f.livekit_service_url === want);
  if (!hit) problems.push(`rtc_foci has no livekit entry for ${want}`);
  return problems.length
    ? fail(label, problems.join("; "), "Compare caddy/Caddyfile with CHAT_FQDN/RTC_FQDN in .env, then `docker compose up -d`.")
    : ok(label, "homeserver + rtc_foci correct");
}

export function checkVersions(doc) {
  const label = "/_matrix/client/versions";
  return Array.isArray(doc?.versions) && doc.versions.length
    ? ok(label, `${doc.versions.length} versions, latest ${doc.versions.at(-1)}`)
    : fail(label, "no versions in response", "docker compose logs tuwunel (is it up? is TUWUNEL_SERVER_NAME = CHAT_FQDN?).");
}

export function checkJwtHealth(rtcFqdn, status) {
  const label = `lk-jwt-service health (https://${rtcFqdn}/livekit/jwt/healthz)`;
  return status === 200
    ? ok(label, "200")
    : fail(label, status ? `HTTP ${status}` : "no response", "docker compose logs lk-jwt-service livekit; check LIVEKIT_API_KEY/SECRET are set.");
}

/**
 * @param {string} psOutput stdout of `docker compose ps --format json`
 *   (newline-delimited objects on compose >= 2.21, an array on older versions)
 */
export function parseComposePs(psOutput) {
  const text = String(psOutput).trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

export function checkContainers(entries, wanted = COMPOSE_SERVICES) {
  const label = "containers up";
  const down = wanted.filter((svc) => !entries.some((e) => e.Service === svc && e.State === "running"));
  return down.length
    ? fail(label, `not running: ${down.join(", ")}`, `docker compose up -d && docker compose logs ${down[0]}`)
    : ok(label, wanted.join(", "));
}

/**
 * Run every doctor check. `io` supplies the side effects, so tests pass fakes:
 *   resolve4(host) -> string[]   tcp(host, port) -> boolean
 *   cert(ip, servername) -> {authorized, validTo, error}|null
 *   getJson(url) -> object|null  getStatus(url) -> number|0
 *   composePs() -> string
 */
export async function runDoctor(env, io, now = new Date()) {
  const { CHAT_FQDN: chat, RTC_FQDN: rtc, MESH_IP: ip } = env;
  const safe = async (f, dflt) => { try { return await f(); } catch { return dflt; } };
  const results = [];
  for (const fqdn of [chat, rtc]) results.push(checkDns("dns", fqdn, ip, await safe(() => io.resolve4(fqdn), [])));
  for (const port of [443, 7881]) results.push(checkPort(ip, port, await safe(() => io.tcp(ip, port), false)));
  for (const fqdn of [chat, rtc]) results.push(checkTls(fqdn, await safe(() => io.cert(ip, fqdn), null), now));
  results.push(checkWellKnown(chat, rtc, await safe(() => io.getJson(`https://${chat}/.well-known/matrix/client`), null)));
  results.push(checkVersions(await safe(() => io.getJson(`https://${chat}/_matrix/client/versions`), null)));
  results.push(checkJwtHealth(rtc, await safe(() => io.getStatus(`https://${rtc}/livekit/jwt/healthz`), 0)));
  results.push(checkContainers(await safe(async () => parseComposePs(await io.composePs()), [])));
  return results;
}

export function formatDoctor(results) {
  const lines = [];
  for (const r of results) {
    lines.push(`${r.ok ? "OK  " : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (!r.ok && r.fix) lines.push(`     fix: ${r.fix}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  lines.push("", bad ? `${bad} of ${results.length} checks failed.` : `All ${results.length} checks passed.`);
  lines.push("UDP 50000-50100 cannot be probed from here; test a real call (docs/DEPLOY.md, on-device checks).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tuwunel admin room (token issue, user list)
//
// Tuwunel has no admin HTTP API. Admin commands are messages beginning with
// `!admin ` sent to the admin room (#admins:<server_name>) by an admin; the
// server user replies in the same room. The first registered user is made
// admin (grant_admin_to_first_user, default true), which bootstrap guarantees
// is SQUADZ_ADMIN_USER. Source: tuwunel src/admin/token/mod.rs (`token issue
// --once`), src/admin/user/commands.rs (`users list-users`).
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send an admin command and wait for the server user's reply.
 * @param {string} serverName
 * @param {string} command e.g. "token issue --once"
 * @param {RegExp} replyPattern the reply body must match this
 * @returns {Promise<string>} the reply body
 */
export async function adminCommand(client, userId, serverName, command, replyPattern, { tries = 20, delayMs = 500 } = {}) {
  const roomId = await client.resolveAlias(`#admins:${serverName}`);
  if (!roomId) throw new Error(`admin room #admins:${serverName} not found. Has Tuwunel started and has ${userId} registered first?`);
  const { event_id } = await client.sendText(roomId, `!admin ${command}`);
  for (let i = 0; i < tries; i++) {
    const { chunk = [] } = await client.messages(roomId, 20);
    for (const ev of chunk) {
      if (ev.event_id === event_id) break; // reached our own message: nothing newer matched
      const body = ev.content?.body;
      if (ev.type === "m.room.message" && ev.sender !== userId && typeof body === "string" && replyPattern.test(body)) return body;
    }
    await sleep(delayMs);
  }
  throw new Error(`no reply to "!admin ${command}" in #admins (is ${userId} an admin?)`);
}

/** Issue a registration token. once=true => single-use. */
export async function issueToken(client, userId, serverName, { once = true, ...wait } = {}) {
  const body = await adminCommand(
    client, userId, serverName, `token issue${once ? " --once" : ""}`,
    /New registration token issued: `[^`]+`/, wait,
  );
  return body.match(/issued: `([^`]+)`/)[1];
}

/** List local usernames as full MXIDs. */
export async function listUsers(client, userId, serverName, wait = {}) {
  const body = await adminCommand(client, userId, serverName, "users list-users", /local user account/, wait);
  return [...body.matchAll(/@[^\s:`]+:[^\s`]+/g)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------

/** Suggest a username from a free-text name hint. */
export function suggestUsername(hint) {
  const s = String(hint ?? "").toLowerCase().replace(/[^a-z0-9._=-]+/g, "");
  return s || null;
}

/**
 * The pasteable message. Pure.
 * @param {object} p
 * @param {string} p.chatFqdn @param {string} p.token
 * @param {boolean} p.singleUse @param {string} [p.name]
 * @param {string} [p.meshInvite] Tailscale invite/share link, if the host has one
 * @param {boolean} [p.web] mention the hosted web client (default true)
 */
export function buildInviteMessage({ chatFqdn, token, singleUse, name, meshInvite, web = true }) {
  const user = suggestUsername(name);
  const hi = name ? `Hey ${name}!` : "Hey!";
  const L = [];
  L.push(`${hi} You're invited to Squadz, our private chat + voice server. Four steps:`);
  L.push("");
  L.push("1. Join the private network (Tailscale). The server isn't on the public internet.");
  L.push(`   - Install Tailscale: https://tailscale.com/download (iOS, Android, Windows, macOS, Linux).`);
  L.push(meshInvite
    ? `   - Join our tailnet with this link: ${meshInvite}`
    : "   - Accept the tailnet invite I sent you, then sign in with the same account.");
  L.push("   - Leave Tailscale connected whenever you use Squadz.");
  L.push("");
  L.push("2. Install the app.");
  L.push("   - Phone: Element X (App Store / Google Play).");
  L.push("   - Desktop: Element (https://element.io/download)" + (web ? `, or just open https://${chatFqdn}/ in a browser.` : "."));
  L.push("");
  L.push("3. Create your account.");
  L.push(`   - Server: ${chatFqdn}  (in Element X: "Create account" > Change account provider > type it).`);
  L.push(`   - Pick your own username${user ? ` (e.g. ${user})` : ""} and a strong password.`);
  L.push(`   - Registration token: ${token}${singleUse ? "  (works once, so don't share it)" : ""}`);
  L.push("");
  L.push('4. You land in the "Squadz" Space automatically. Rooms: General, Games, Clips, Memes, plus voice rooms Lounge and Game Night.');
  L.push("   Tap a voice room, then the call button to talk. Save the recovery key Element shows you.");
  L.push("");
  L.push("Stuck? Ping me. Full guide: docs/ONBOARDING.md in the repo.");
  return L.join("\n");
}

/** Pick a token: single-use via the admin room, or the shared one from .env. */
export async function obtainToken({ client, userId, serverName, shared, sharedToken, log = () => {}, wait }) {
  if (shared) {
    if (!sharedToken) throw new Error("TUWUNEL_REGISTRATION_TOKEN is not set in .env");
    return { token: sharedToken, singleUse: false };
  }
  try {
    return { token: await issueToken(client, userId, serverName, { once: true, ...wait }), singleUse: true };
  } catch (err) {
    log(`warning: could not issue a single-use token (${err.message}).`);
    log("         Falling back to the shared TUWUNEL_REGISTRATION_TOKEN: anyone holding it can register, so rotate it in .env after onboarding.");
    if (!sharedToken) throw err;
    return { token: sharedToken, singleUse: false };
  }
}

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

export const ROLE_LEVELS = { owner: 100, mod: 50, member: 0 };

export function aliasesFor(serverName) {
  return [SPACE, ...ROOMS].map((d) => `#${d.slug}:${serverName}`);
}

/** Pure: new power_levels content with `userId` at `level` (0 removes the entry). */
export function withUserLevel(content, userId, level) {
  const next = structuredClone(content ?? {});
  next.users = { ...(next.users ?? {}) };
  if (level === 0) delete next.users[userId];
  else next.users[userId] = level;
  return next;
}

/** Pure: true if some user would still have an effective power level >= `minLevel`. */
export function hasUserAtLevel(content, minLevel) {
  if (Number(content?.users_default) >= minLevel) return true;
  return Object.values(content?.users ?? {}).some((v) => Number(v) >= minLevel);
}

/**
 * Set a user's role in the Space and every seeded room. Idempotent: rooms
 * already at the right level are not written.
 * @returns {{changed: string[], unchanged: string[], missing: string[]}}
 */
export async function setRole(client, config, userArg, role, { force = false } = {}) {
  if (!Object.hasOwn(ROLE_LEVELS, role)) throw new Error(`role must be one of: ${Object.keys(ROLE_LEVELS).join(", ")}`);
  const level = ROLE_LEVELS[role];
  const userId = toUserId(userArg, config.serverName);
  if (userId === config.adminUserId && level < 100 && !force) {
    throw new Error(`${userId} is the admin account; refusing to demote it without --force`);
  }
  if (!(await client.getProfile(userId))) throw new Error(`${userId} does not exist on ${config.serverName} (they must register first)`);

  const out = { changed: [], unchanged: [], missing: [] };
  for (const alias of aliasesFor(config.serverName)) {
    const roomId = await client.resolveAlias(alias);
    if (!roomId) { out.missing.push(alias); continue; }
    const current = await client.getState(roomId, "m.room.power_levels", "");
    const next = withUserLevel(current, userId, level);
    if (current && isDeepStrictEqual(current, next)) { out.unchanged.push(alias); continue; }
    if (!hasUserAtLevel(next, 100)) {
      throw new Error(`refusing to demote ${userId}: no user would remain at power level >= 100 in ${alias}`);
    }
    await client.putState(roomId, "m.room.power_levels", "", next);
    out.changed.push(alias);
  }
  if (out.missing.length === aliasesFor(config.serverName).length) {
    throw new Error("no Squadz rooms found; run `node scripts/bootstrap.mjs` first");
  }
  return out;
}

// ---------------------------------------------------------------------------
// sync-members (fallback when auto_join_rooms did not run for someone)
// ---------------------------------------------------------------------------

/**
 * Invite every local user (except the admin and the bot unless listed) to the
 * Space. Child rooms are restricted-to-Space, so one invite is enough.
 * @returns {{invited: string[], already: string[]}}
 */
export async function syncMembers(client, config, users, log = () => {}) {
  const spaceId = await client.resolveAlias(`#${SPACE.slug}:${config.serverName}`);
  if (!spaceId) throw new Error("Space not found; run `node scripts/bootstrap.mjs` first");
  const out = { invited: [], already: [] };
  for (const userId of users) {
    if (userId === config.adminUserId) continue;
    const m = await client.getMember(spaceId, userId);
    if (m && (m.membership === "join" || m.membership === "invite")) { out.already.push(userId); continue; }
    try {
      await client.invite(spaceId, userId);
      out.invited.push(userId);
    } catch (err) {
      log(`skip ${userId}: ${err.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

/** squadz-backup-YYYYMMDD-HHMMSS.tar.gz (UTC). */
export function backupFileName(date = new Date()) {
  const p = date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `squadz-backup-${p}.tar.gz`;
}
