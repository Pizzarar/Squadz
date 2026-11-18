// Mesh-only mode (P4 E1): setup env generation, validate in internal mode, doctor mesh branch, ca export.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { caReexecEnv, cmdCaExport, parseArgs } from "../squadz.mjs";
import {
  buildMeshEnvValues, caTrustInstructions, generateSecrets, hostsLine, isInternalTls, parseNordLocalIp,
  renderEnv, runDoctor, validateEnvForMode, validateMeshInputs, checkMeshHost, checkMeshTls, formatDoctor,
} from "../lib/ops.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const template = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

function parse(text) {
  return new Map(text.split(/\r?\n/).filter((l) => /^[A-Z]/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

test("mesh env: internal TLS, no Cloudflare token, default hosts, compose overlay", () => {
  const secrets = generateSecrets();
  const env = parse(renderEnv(template, buildMeshEnvValues({ meshIp: "100.101.102.103", adminUser: "aub", secrets })));
  assert.equal(env.get("SQUADZ_TLS"), "internal");
  assert.equal(env.get("CLOUDFLARE_API_TOKEN"), "");
  assert.equal(env.get("CHAT_FQDN"), "chat.squadz.mesh");
  assert.equal(env.get("RTC_FQDN"), "rtc.squadz.mesh");
  assert.equal(env.get("MESH_IP"), "100.101.102.103");
  assert.equal(env.get("SQUADZ_ADMIN_USER"), "aub");
  assert.match(env.get("COMPOSE_FILE"), /docker-compose\.mesh\.yml/);
  assert.equal(env.get("LIVEKIT_API_SECRET"), secrets.LIVEKIT_API_SECRET);
  assert.deepEqual(validateEnvForMode(env), []);
  assert.ok(isInternalTls(Object.fromEntries(env)));
});

test("mesh env: custom hosts flow through; validation rejects bad input", () => {
  const v = buildMeshEnvValues({ meshIp: "100.64.1.1", chatHost: "c.team.mesh", rtcHost: "r.team.mesh", secrets: {} });
  assert.equal(v.SQUADZ_DOMAIN, "team.mesh");
  assert.deepEqual(validateMeshInputs({ meshIp: "100.64.1.1", chatHost: "c.team.mesh", rtcHost: "r.team.mesh" }), []);
  const bad = validateMeshInputs({ meshIp: "192.168.1.5", chatHost: "x", rtcHost: "x" });
  assert.ok(bad.some((p) => p.includes("100.64.0.0/10")));
  assert.ok(bad.some((p) => p.includes("--chat-host")));
  assert.ok(validateMeshInputs({ meshIp: "100.64.1.1", chatHost: "a.b.mesh", rtcHost: "A.B.mesh" }).some((p) => p.includes("must differ")));
  assert.equal(hostsLine("100.64.1.1", "a.mesh", "b.mesh"), "100.64.1.1 a.mesh b.mesh");
});

test("parseArgs accepts the mesh flags", () => {
  const { flags } = parseArgs(["--mesh-only", "--mesh-ip", "100.64.0.9", "--chat-host=c.x.mesh", "--rtc-host", "r.x.mesh"]);
  assert.equal(flags["mesh-only"], true);
  assert.equal(flags["mesh-ip"], "100.64.0.9");
  assert.equal(flags["chat-host"], "c.x.mesh");
  assert.equal(flags["rtc-host"], "r.x.mesh");
});

test("parseNordLocalIp prefers the Local Peer block over remote peers", () => {
  const out = `Local Peer:
Hostname: my-pc.nord
IP: 100.90.1.2
Public Key: abc

Remote Peers:
Hostname: friend.nord
IP: 100.90.9.9
`;
  assert.equal(parseNordLocalIp(out), "100.90.1.2");
  assert.equal(parseNordLocalIp("Hostname: x\nIP: 100.70.0.5"), "100.70.0.5");
  assert.equal(parseNordLocalIp("nothing"), null);
});

test("validate: real-domain mode still needs the Cloudflare token; internal mode does not", () => {
  const base = { CHAT_FQDN: "chat.e.com", RTC_FQDN: "rtc.e.com", MESH_IP: "100.64.0.1", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s", TUWUNEL_REGISTRATION_TOKEN: "t", ACME_EMAIL: "a@e.com", SQUADZ_DOMAIN: "e.com", CLOUDFLARE_API_TOKEN: "" };
  assert.ok(validateEnvForMode(base).some((p) => p.includes("CLOUDFLARE_API_TOKEN")));
  assert.deepEqual(validateEnvForMode({ ...base, CLOUDFLARE_API_TOKEN: "tok" }), []);
  const mesh = { ...base, SQUADZ_TLS: "internal", COMPOSE_FILE: "docker-compose.yml:docker-compose.mesh.yml", ACME_EMAIL: "", SQUADZ_DOMAIN: "" };
  assert.deepEqual(validateEnvForMode(mesh), []);
  assert.ok(validateEnvForMode({ ...mesh, COMPOSE_FILE: "" }).some((p) => p.includes("docker-compose.mesh.yml")));
  assert.ok(validateEnvForMode({ ...mesh, SQUADZ_TLS: "bogus" }).some((p) => p.includes("unknown")));
  assert.ok(validateEnvForMode({ ...mesh, RTC_FQDN: "chat.e.com" }).some((p) => p.includes("must differ")));
  assert.ok(validateEnvForMode({ ...mesh, MESH_IP: "10.0.0.1" }).some((p) => p.includes("100.64.0.0/10")));
});

const meshEnv = { CHAT_FQDN: "chat.squadz.mesh", RTC_FQDN: "rtc.squadz.mesh", MESH_IP: "100.64.0.1", SQUADZ_TLS: "internal" };
const now = new Date("2026-11-18T00:00:00Z");
const goodIo = (over = {}) => ({
  resolve4: async () => { throw new Error("public DNS must not be used in mesh mode"); },
  cert: async () => { throw new Error("public TLS check must not be used in mesh mode"); },
  resolveLocal: async () => ["100.64.0.1"],
  readCa: async () => "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
  certChain: async () => ({ authorized: true, validTo: "Nov 18 00:00:00 2027 GMT" }),
  tcp: async () => true,
  getJson: async (u) => (u.includes("well-known")
    ? { "m.homeserver": { base_url: "https://chat.squadz.mesh" }, "org.matrix.msc4143.rtc_foci": [{ type: "livekit", livekit_service_url: "https://rtc.squadz.mesh/livekit/jwt" }] }
    : { versions: ["v1.11"] }),
  getStatus: async () => 200,
  composePs: async () => ["caddy", "tuwunel", "livekit", "lk-jwt-service"].map((Service) => JSON.stringify({ Service, State: "running" })).join("\n"),
  ...over,
});

test("doctor mesh branch: skips public DNS/ACME, checks local resolution and CA chain", async () => {
  const results = await runDoctor(meshEnv, goodIo(), now);
  assert.ok(results.every((r) => r.ok), formatDoctor(results));
  const names = results.map((r) => r.name);
  assert.ok(names.some((n) => n.startsWith("host chat.squadz.mesh -> 100.64.0.1")));
  assert.ok(names.some((n) => n.startsWith("TLS rtc.squadz.mesh chains to squadz-ca.crt")));
  assert.ok(!names.some((n) => n.startsWith("DNS ")));
});

test("doctor mesh branch: missing hosts entry, wrong IP, missing CA, untrusted cert", async () => {
  const noHosts = await runDoctor(meshEnv, goodIo({ resolveLocal: async () => { throw new Error("ENOTFOUND"); } }), now);
  const f1 = noHosts.find((r) => r.name.startsWith("host chat"));
  assert.equal(f1.ok, false);
  assert.match(f1.fix, /hosts file/);

  const wrongIp = checkMeshHost("chat.squadz.mesh", "100.64.0.1", ["100.64.0.7"]);
  assert.equal(wrongIp.ok, false);
  assert.match(wrongIp.detail, /100\.64\.0\.7/);

  const noCa = await runDoctor(meshEnv, goodIo({ readCa: async () => null }), now);
  const f2 = noCa.find((r) => r.name.startsWith("TLS chat"));
  assert.equal(f2.ok, false);
  assert.match(f2.fix, /ca export/);

  const untrusted = checkMeshTls("chat.squadz.mesh", "pem", { authorized: false, validTo: "Nov 18 00:00:00 2027 GMT" }, now);
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.detail, /does not chain/);
  assert.equal(checkMeshTls("c", "pem", { error: "self-signed certificate" }, now).ok, false);
  assert.equal(checkMeshTls("c", "pem", { authorized: true, validTo: "Nov 1 00:00:00 2026 GMT" }, now).ok, false);
});

test("doctor outside mesh mode is unchanged (public DNS path)", async () => {
  let dnsCalls = 0;
  await runDoctor({ CHAT_FQDN: "chat.e.com", RTC_FQDN: "rtc.e.com", MESH_IP: "100.64.0.1" }, {
    resolve4: async () => { dnsCalls++; return ["100.64.0.1"]; },
    tcp: async () => true, cert: async () => ({ authorized: true, validTo: "Nov 18 00:00:00 2027 GMT" }),
    getJson: async () => null, getStatus: async () => 0, composePs: async () => "",
  }, now);
  assert.equal(dnsCalls, 2);
});

test("ca export copies the root CA via docker compose cp and prints trust steps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-ca-"));
  try {
    const out = path.join(dir, "squadz-ca.crt");
    const calls = [];
    const logs = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      fs.writeFileSync(args.at(-1), "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
      return { status: 0, stdout: "", stderr: "" };
    };
    cmdCaExport({ out }, { run, log: (m) => logs.push(m) });
    assert.deepEqual(calls[0].slice(0, 4), ["docker", "compose", "cp", "caddy:/data/caddy/pki/authorities/local/root.crt"]);
    assert.match(fs.readFileSync(out, "utf8"), /BEGIN CERTIFICATE/);
    assert.ok(!fs.existsSync(`${out}.tmp`));
    const text = logs.join("\n");
    for (const needle of ["certutil -user -addstore Root", "security add-trusted-cert", "update-ca-certificates", "Firefox", "Certificate Trust Settings", "Install a certificate", "Element X"]) {
      assert.ok(text.includes(needle), `trust text missing: ${needle}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ca export fails clearly when caddy has no CA yet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-ca-"));
  try {
    const run = () => ({ status: 1, stdout: "", stderr: "no such container" });
    assert.throws(() => cmdCaExport({ out: path.join(dir, "x.crt") }, { run, log() {} }), /could not copy Caddy's root CA/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trust instructions state the Element X Android limit honestly", () => {
  assert.match(caTrustInstructions(), /Element X on Android will most likely refuse/);
});

test("caReexecEnv: trusts the exported CA only in internal TLS mode, once, when the file is non-empty", () => {
  const yes = () => true;
  const r = caReexecEnv({ SQUADZ_TLS: "internal" }, "/x/squadz-ca.crt", yes);
  assert.equal(r.NODE_EXTRA_CA_CERTS, "/x/squadz-ca.crt");
  assert.equal(r.SQUADZ_CA_REEXEC, "1");
  assert.equal(caReexecEnv({ SQUADZ_TLS: "internal" }, "/x/ca", () => false), null, "empty/missing placeholder");
  assert.equal(caReexecEnv({ SQUADZ_TLS: "internal", NODE_EXTRA_CA_CERTS: "/y" }, "/x/ca", yes), null, "user already set it");
  assert.equal(caReexecEnv({ SQUADZ_TLS: "internal", SQUADZ_CA_REEXEC: "1" }, "/x/ca", yes), null, "no re-exec loop");
  assert.equal(caReexecEnv({ SQUADZ_TLS: "acme" }, "/x/ca", yes), null, "public TLS mode");
});
