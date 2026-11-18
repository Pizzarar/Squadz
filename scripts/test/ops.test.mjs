// scripts/test/ops.test.mjs
//
// Tests for scripts/lib/ops.mjs (the logic behind scripts/squadz.mjs):
// invite / role / sync-members against the mock homeserver, plus the pure
// parts of setup, doctor and backup.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockHomeserver } from "./mock-homeserver.mjs";
import { createMatrixClient } from "../lib/matrix.mjs";
import { seed } from "../lib/seed.mjs";
import { cmdBackup } from "../squadz.mjs";
import {
  aliasesFor, backupFileName, buildEnvValues, buildInviteMessage, checkContainers, checkDns,
  checkJwtHealth, checkTls, checkVersions, checkWellKnown, formatDoctor, generateSecrets,
  hasUserAtLevel, isFqdn, issueToken, listUsers, obtainToken, parseComposePs, parseMeshIp,
  renderEnv, runDoctor, setRole, suggestUsername, syncMembers, validateSetupInputs, withUserLevel,
} from "../lib/ops.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = "chat.squadz.test";
const mock = createMockHomeserver({ serverName: SERVER, registrationToken: "shared-token" });
let client;
let config;

const stateOf = (alias, type) => {
  const room = mock.state.rooms.get(mock.state.aliases.get(alias));
  return room.state.get(`${type}\u0000`);
};

before(async () => {
  const port = await mock.start();
  mock.state.users.set("friend", { password: "pw" });
  mock.state.users.set("pal", { password: "pw" });
  config = {
    serverName: SERVER, homeserverUrl: mock.url(port), registrationToken: "shared-token",
    adminUser: "admin", adminUserId: `@admin:${SERVER}`, adminPassword: "admin-pw",
    invite: [], emojiDir: path.resolve(here, "..", "..", "assets", "emoji"),
  };
  client = createMatrixClient(config.homeserverUrl);
  await seed(client, config);
  // Tuwunel creates #admins itself; the mock needs one for the admin bot.
  const { room_id } = await client.createRoom({ room_alias_name: "admins" });
  assert.ok(room_id);
});

after(() => mock.stop());

// --- setup (pure) ----------------------------------------------------------

test("generateSecrets: strong, distinct, LiveKit-compatible", () => {
  const s = generateSecrets();
  assert.match(s.LIVEKIT_API_KEY, /^lk_[0-9a-f]{12}$/);
  assert.ok(s.LIVEKIT_API_SECRET.length >= 32);
  assert.equal(new Set(Object.values(s)).size, Object.keys(s).length, "all distinct");
  assert.notDeepEqual(generateSecrets(), s, "random each call");
});

test("parseMeshIp finds CGNAT addresses in tailscale / meshnet output", () => {
  assert.equal(parseMeshIp("100.101.102.103\n"), "100.101.102.103");
  assert.equal(parseMeshIp("Local Peer:\nHostname: box\nIP: 100.88.1.2\nPeers: 10.0.0.1"), "100.88.1.2");
  assert.equal(parseMeshIp("192.168.1.5 and 100.200.0.1"), null, "100.200 is outside 100.64/10");
  assert.equal(parseMeshIp(""), null);
});

test("validateSetupInputs flags bad input and accepts good input", () => {
  assert.deepEqual(validateSetupInputs({ domain: "example.com", cloudflareToken: "x".repeat(40), meshIp: "100.64.0.9", email: "a@b.co" }), []);
  const bad = validateSetupInputs({ domain: "nodot", cloudflareToken: "short", meshIp: "10.0.0.1", email: "nope" });
  assert.equal(bad.length, 4);
  assert.ok(isFqdn("example.com") && !isFqdn("https://example.com"));
});

test("renderEnv keeps the template layout and fills values; buildEnvValues derives FQDNs", () => {
  const tpl = "# c\nCHAT_FQDN=chat.example.com\nMESH_IP=1\n\nEXTRA=keep\n";
  const out = renderEnv(tpl, { CHAT_FQDN: "chat.a.io", MESH_IP: "100.64.0.2", NEW: "n" });
  assert.equal(out, "# c\nCHAT_FQDN=chat.a.io\nMESH_IP=100.64.0.2\n\nEXTRA=keep\nNEW=n\n");
  const v = buildEnvValues({ domain: "a.io", cloudflareToken: "t", meshIp: "100.64.0.2", secrets: { X: "1" } });
  assert.equal(v.CHAT_FQDN, "chat.a.io");
  assert.equal(v.RTC_FQDN, "rtc.a.io");
  assert.equal(v.ACME_EMAIL, "admin@a.io");
  assert.equal(v.SQUADZ_ADMIN_USER, "admin");
});

// --- doctor (pure + fakes) ------------------------------------------------

const ENV = { CHAT_FQDN: "chat.a.io", RTC_FQDN: "rtc.a.io", MESH_IP: "100.64.0.2" };
const GOOD_PS = ["caddy", "tuwunel", "livekit", "lk-jwt-service"].map((Service) => JSON.stringify({ Service, State: "running" })).join("\n");
const goodIo = () => ({
  resolve4: async () => ["100.64.0.2"],
  tcp: async () => true,
  cert: async () => ({ authorized: true, validTo: "Jan 1 00:00:00 2099 GMT" }),
  getJson: async (url) => url.endsWith("versions")
    ? { versions: ["v1.1", "v1.12"] }
    : { "m.homeserver": { base_url: "https://chat.a.io" }, "org.matrix.msc4143.rtc_foci": [{ type: "livekit", livekit_service_url: "https://rtc.a.io/livekit/jwt" }] },
  getStatus: async () => 200,
  composePs: async () => GOOD_PS,
});

test("doctor: everything healthy -> all OK", async () => {
  const r = await runDoctor(ENV, goodIo());
  assert.equal(r.length, 10);
  assert.ok(r.every((x) => x.ok), formatDoctor(r));
  assert.match(formatDoctor(r), /All 10 checks passed/);
});

test("doctor: each failure prints FAIL with a fix", async () => {
  const io = { ...goodIo(), resolve4: async () => ["1.2.3.4"], tcp: async () => false, cert: async () => null,
    getJson: async () => ({ "m.homeserver": { base_url: "https://wrong" } }), getStatus: async () => 502,
    composePs: async () => JSON.stringify({ Service: "caddy", State: "running" }) };
  const r = await runDoctor(ENV, io);
  assert.ok(r.filter((x) => !x.ok).length >= 9);
  assert.ok(r.filter((x) => !x.ok).every((x) => x.fix), "every failure has a fix");
  const text = formatDoctor(r);
  assert.match(text, /FAIL DNS chat\.a\.io -> 100\.64\.0\.2 — resolves to 1\.2\.3\.4/);
  assert.match(text, /fix: /);
});

test("doctor: a throwing probe counts as FAIL, not a crash", async () => {
  const io = { ...goodIo(), resolve4: async () => { throw new Error("ENOTFOUND"); } };
  const r = await runDoctor(ENV, io);
  assert.equal(r[0].ok, false);
});

test("individual checks: tls expiry, well-known foci, compose ps formats", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(checkTls("x", { authorized: true, validTo: "Jan 3 00:00:00 2026 GMT" }, now).ok, false, "<7d");
  assert.equal(checkTls("x", { authorized: true, validTo: "Dec 1 00:00:00 2025 GMT" }, now).ok, false, "expired");
  assert.equal(checkTls("x", { authorized: false, validTo: "Jan 1 00:00:00 2030 GMT" }, now).ok, false, "untrusted");
  assert.equal(checkTls("x", { authorized: true, validTo: "Jan 1 00:00:00 2030 GMT" }, now).ok, true);
  assert.equal(checkWellKnown("chat.a.io", "rtc.a.io", { "m.homeserver": { base_url: "https://chat.a.io" }, "org.matrix.msc4143.rtc_foci": [] }).ok, false);
  assert.equal(checkDns("d", "chat.a.io", "100.64.0.2", []).ok, false);
  assert.equal(checkVersions({}).ok, false);
  assert.equal(checkJwtHealth("rtc.a.io", 200).ok, true);
  assert.equal(parseComposePs(`[{"Service":"a","State":"running"}]`).length, 1, "array form");
  assert.equal(parseComposePs(GOOD_PS).length, 4, "ndjson form");
  assert.equal(checkContainers(parseComposePs(GOOD_PS)).ok, true);
  assert.match(checkContainers([]).detail, /caddy, tuwunel/);
});

// --- invite ----------------------------------------------------------------

test("invite: issues a single-use token via the admin room and builds the message", async () => {
  const token = await issueToken(client, `@admin:${SERVER}`, SERVER, { once: true, tries: 3, delayMs: 5 });
  assert.equal(token, "tok1");
  assert.deepEqual(mock.state.issuedTokens.at(-1), { token: "tok1", once: true });

  const r = await obtainToken({ client, userId: `@admin:${SERVER}`, serverName: SERVER, shared: false, sharedToken: "shared-token", wait: { tries: 3, delayMs: 5 } });
  assert.equal(r.singleUse, true);
  assert.equal(r.token, "tok2");

  const msg = buildInviteMessage({ chatFqdn: SERVER, token: r.token, singleUse: true, name: "Sam", meshInvite: "https://login.tailscale.com/uinv/abc" });
  for (const needle of ["Hey Sam!", "Tailscale", "Element X", SERVER, "tok2", "works once", "https://login.tailscale.com/uinv/abc", "Squadz", "(e.g. sam)"]) {
    assert.ok(msg.includes(needle), `message mentions ${needle}`);
  }
  assert.ok(!msg.includes("shared-token"));
});

test("invite --shared uses the .env token; admin-room failure falls back with a warning", async () => {
  const shared = await obtainToken({ shared: true, sharedToken: "shared-token" });
  assert.deepEqual(shared, { token: "shared-token", singleUse: false });
  await assert.rejects(obtainToken({ shared: true, sharedToken: "" }), /not set/);

  mock.state.adminSilent = true;
  const logs = [];
  const fb = await obtainToken({ client, userId: `@admin:${SERVER}`, serverName: SERVER, shared: false, sharedToken: "shared-token", log: (m) => logs.push(m), wait: { tries: 2, delayMs: 5 } });
  mock.state.adminSilent = false;
  assert.deepEqual(fb, { token: "shared-token", singleUse: false });
  assert.match(logs.join("\n"), /Falling back to the shared/);
  assert.match(buildInviteMessage({ chatFqdn: SERVER, token: "t", singleUse: false }), /Hey!/);
  assert.equal(suggestUsername("Sam O'Neil"), "samoneil");
  assert.equal(suggestUsername(""), null);
});

// --- role ------------------------------------------------------------------

test("role: owner/mod/member set power levels in the Space and every room, idempotently", async () => {
  const friend = `@friend:${SERVER}`;
  const aliases = aliasesFor(SERVER);
  assert.equal(aliases.length, 7);

  let r = await setRole(client, config, "friend", "mod");
  assert.equal(r.changed.length, 7);
  for (const a of aliases) assert.equal(stateOf(a, "m.room.power_levels").users[friend], 50, a);
  assert.equal(stateOf(aliases[0], "m.room.power_levels").users[`@admin:${SERVER}`], 100, "admin kept");

  const puts = mock.state.counts.putState;
  r = await setRole(client, config, friend, "mod");
  assert.equal(r.changed.length, 0);
  assert.equal(r.unchanged.length, 7);
  assert.equal(mock.state.counts.putState, puts, "second run writes nothing");

  await setRole(client, config, "friend", "owner");
  assert.equal(stateOf(aliases[3], "m.room.power_levels").users[friend], 100);
  await setRole(client, config, "friend", "member");
  for (const a of aliases) assert.equal(stateOf(a, "m.room.power_levels").users[friend], undefined, "member = no entry");
});

test("role: rejects bad role, unknown user, and demoting the admin", async () => {
  await assert.rejects(setRole(client, config, "friend", "god"), /role must be/);
  await assert.rejects(setRole(client, config, "ghost", "mod"), /does not exist/);
  await assert.rejects(setRole(client, config, "admin", "member"), /refusing to demote/);
  assert.deepEqual(withUserLevel({ users: { a: 1 }, ban: 50 }, "b", 50), { users: { a: 1, b: 50 }, ban: 50 });
});

test("role: refuses to demote the last user at power level >= 100, even with --force", async () => {
  assert.equal(hasUserAtLevel({ users: { a: 100 }, users_default: 0 }, 100), true);
  assert.equal(hasUserAtLevel({ users: { a: 50 }, users_default: 0 }, 100), false);
  assert.equal(hasUserAtLevel({ users: {}, users_default: 100 }, 100), true);
  await assert.rejects(
    setRole(client, config, "admin", "member", { force: true }),
    /no user would remain at power level >= 100/,
  );
});

// --- sync-members ----------------------------------------------------------

test("sync-members invites every local user to the Space once", async () => {
  const users = await listUsers(client, `@admin:${SERVER}`, SERVER, { tries: 3, delayMs: 5 });
  assert.ok(users.includes(`@friend:${SERVER}`) && users.includes(`@pal:${SERVER}`));
  const r1 = await syncMembers(client, config, users);
  assert.ok(r1.invited.includes(`@friend:${SERVER}`) && r1.invited.includes(`@pal:${SERVER}`));
  assert.ok(!r1.invited.includes(`@admin:${SERVER}`));
  const r2 = await syncMembers(client, config, users);
  assert.equal(r2.invited.length, 0);
  assert.equal(r2.already.length, r1.invited.length);
});

// --- backup ----------------------------------------------------------------

test("backupFileName is dated and sortable", () => {
  assert.equal(backupFileName(new Date("2026-11-17T09:05:03.123Z")), "squadz-backup-20261117-090503.tar.gz");
});

test("backup: a tar failure still removes the staging dir (and its copied .env)", () => {
  const tmp = os.tmpdir();
  const marker = "squadz-backup-";
  const before = new Set(readdirSync(tmp).filter((d) => d.startsWith(marker)));
  const fakeEnv = path.join(tmp, `squadz-test-env-${process.pid}-${Date.now()}.env`);
  writeFileSync(fakeEnv, "SQUADZ_DOMAIN=example.com\n");
  const stubRun = (cmd, args) => {
    if (cmd === "tar" && args[0] === "czf") return { status: 1, stdout: "", stderr: "tar: fail", error: null };
    if (cmd === "docker") {
      if (args[0] === "compose" && args[1] === "config") return { status: 0, stdout: '{"name":"squadz"}' };
      if (args[0] === "volume") return { status: 0, stdout: "squadz_tuwunel_data\n" };
      if (args[0] === "compose" && args[1] === "ps") return { status: 0, stdout: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected run: ${cmd} ${args.join(" ")}`);
  };
  try {
    assert.throws(
      () => cmdBackup({ out: tmp }, { run: stubRun, envFile: fakeEnv }),
      /creating the archive/,
    );
    const leftover = readdirSync(tmp).filter((d) => d.startsWith(marker) && !before.has(d));
    assert.deepEqual(leftover, [], "staging dir removed after tar failure");
  } finally {
    rmSync(fakeEnv, { force: true });
  }
});
