#!/usr/bin/env node
// scripts/squadz.mjs: the one ops entry point for Squadz.
//
//   node scripts/squadz.mjs <setup|doctor|invite|role|sync-members|emoji|server|backup|restore|update> [options]
//
// Reuses scripts/lib (config, matrix, seed) and scripts/bootstrap.mjs; the
// testable logic lives in scripts/lib/ops.mjs. Node 20+, no dependencies.

import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { loadEnvFile, resolveConfig } from "./lib/config.mjs";
import { createMatrixClient } from "./lib/matrix.mjs";
import { parseTopicArg, setServer, showServer } from "./lib/server.mjs";
import { probePushGateway } from "./lib/push.mjs";
import { addEmoji, listEmoji, removeEmoji } from "./lib/emoji.mjs";
import {
  COPY_ONCE, buildEnvValues, buildInviteMessage, generateSecrets, listUsers, obtainToken,
  parseMeshIp, renderEnv, runDoctor, formatDoctor, setRole, syncMembers, validateSetupInputs,
  ROLE_LEVELS, backupFileName,
} from "./lib/ops.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

const USAGE = `squadz: ops CLI

Usage: node scripts/squadz.mjs <command> [options]

  setup [--force] [--domain D] [--cloudflare-token T] [--mesh-ip IP] [--email E] [--admin-user U]
        Write .env (prompts for anything not given as a flag). Refuses to overwrite .env without --force.
  doctor                       Check DNS, ports, TLS, well-known, Matrix, lk-jwt and containers.
  invite [--name HINT] [--shared] [--mesh-invite URL] [--no-web]
        Print a pasteable onboarding message with a single-use registration token
        (--shared uses TUWUNEL_REGISTRATION_TOKEN from .env instead). The message
        links the hosted web client (https://CHAT_FQDN/); --no-web omits it.
  role <user> owner|mod|member Set power level (100/50/0) in the Space and every room. Idempotent.
  sync-members                 Invite every local user to the Space (fallback if auto-join missed someone).
  emoji add <shortcode> <image> [--sticker] [--emoji]
        Add a custom emoji (default) or sticker (--sticker) to the Space + every text room.
        Shortcode [a-z0-9_]{2,32}; png/gif/webp/jpg; max 256KB (emoji) / 512KB (sticker).
        Re-adding a shortcode replaces it; other images are kept.
  emoji remove <shortcode>     Remove an emoji/sticker from the pack everywhere.
  emoji list                   List the pack (shortcode, usage, size).
  server show                  Print the Space name, icon (mxc), every room topic and the pinned welcome event id.
  server set [--name STR] [--icon FILE] [--icon-all] [--topic ROOM=TEXT]... [--welcome FILE.md]
        Discord-style server settings, all idempotent. --name renames the Space; --icon sets
        its avatar (png/jpg/webp, max 2MB; --icon-all also applies it to every room);
        --topic sets a room topic (repeatable, e.g. --topic general="Chat here");
        --welcome posts the markdown as a notice in #general and pins it, replacing the old pin.
  backup [--out DIR]           Cold snapshot of the Tuwunel DB + .env + config into a dated tar.gz.
  restore <file> --yes [--with-config]
                               Restore a backup (stops tuwunel, replaces the DB volume).
  update                       docker compose pull, recreate, then doctor.

Global: --env-file <path> (default ./.env)  -h, --help
`;

// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const valued = new Set(["domain", "cloudflare-token", "mesh-ip", "email", "admin-user", "name", "mesh-invite", "out", "env-file", "icon", "welcome"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (k === "topic") {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error("--topic requires a value");
        (flags.topic ??= []).push(v);
      } else if (valued.has(k)) {
        flags[k] = inline ?? argv[++i];
        if (flags[k] === undefined) throw new Error(`--${k} requires a value`);
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
}

function mustWith(runFn, cmd, args, what) {
  const r = runFn(cmd, args, { stdio: "inherit" });
  if (r.error || r.status !== 0) throw new Error(`${what ?? `${cmd} ${args.join(" ")}`} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
}

function must(cmd, args, what) {
  return mustWith(run, cmd, args, what);
}

/** Resolve the .env path a command should read/write: `--env-file` or the default `./.env`. */
function resolveEnvFile(flags) {
  return flags["env-file"] ?? envPath;
}

function loadEnv(flags) {
  const file = resolveEnvFile(flags);
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run: node scripts/squadz.mjs setup`);
  loadEnvFile(file);
  return file;
}

async function adminClient(log) {
  const config = resolveConfig();
  const client = createMatrixClient(config.homeserverUrl);
  const { access_token } = await client.login(config.adminUser, config.adminPassword).catch((err) => {
    throw new Error(`admin login as ${config.adminUserId} failed (${err.message}). Has \`node scripts/bootstrap.mjs\` been run?`);
  });
  client.token = access_token;
  log?.(`logged in as ${config.adminUserId}`);
  return { client, config };
}

// ---------------------------------------------------------------------------
// setup

function detectMeshIp() {
  const tries = [["tailscale", ["ip", "-4"]], ["nordvpn", ["meshnet", "peer", "list"]]];
  for (const [cmd, args] of tries) {
    const r = run(cmd, args);
    if (r.status === 0) {
      const ip = parseMeshIp(r.stdout);
      if (ip) return { ip, via: cmd };
    }
  }
  return null;
}

async function cmdSetup(flags) {
  const envFile = resolveEnvFile(flags);
  if (fs.existsSync(envFile) && !flags.force) {
    throw new Error(`${envFile} already exists. Re-run with --force to overwrite it (this generates NEW secrets and invalidates the old ones).`);
  }
  const interactive = process.stdin.isTTY && !flags.yes;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (label, given, dflt) => {
    if (given) return given;
    if (!rl) return dflt ?? "";
    const a = (await rl.question(`${label}${dflt ? ` [${dflt}]` : ""}: `)).trim();
    return a || dflt || "";
  };
  try {
    const domain = await ask("Domain (e.g. example.com)", flags.domain);
    const cloudflareToken = await ask("Cloudflare API token (Zone:DNS:Edit)", flags["cloudflare-token"] ?? process.env.CLOUDFLARE_API_TOKEN);
    const detected = flags["mesh-ip"] ? null : detectMeshIp();
    if (detected) console.log(`Detected mesh IP ${detected.ip} via ${detected.via}.`);
    const meshIp = await ask("Mesh IP (100.x.y.z)", flags["mesh-ip"], detected?.ip);
    const email = await ask("ACME email", flags.email, domain ? `admin@${domain}` : undefined);
    const adminUser = await ask("Admin username", flags["admin-user"], "admin");

    const problems = validateSetupInputs({ domain, cloudflareToken, meshIp, email });
    if (problems.length) throw new Error(`setup input problems:\n  - ${problems.join("\n  - ")}`);

    const secrets = generateSecrets();
    const values = buildEnvValues({ domain, cloudflareToken, meshIp, email, adminUser, secrets });
    const template = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    fs.writeFileSync(envFile, renderEnv(template, values), { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);

    console.log(`\nWrote ${envFile} (mode 600). Secrets were generated and are stored only there.`);
    console.log(`\nCopy this now; it is the only time it is printed (also readable in .env):`);
    for (const k of COPY_ONCE) console.log(`  ${k}=${secrets[k]}`);
    console.log(`\nNext:`);
    console.log(`  1. In Cloudflare create DNS-only A records: chat.${domain} and rtc.${domain} -> ${meshIp}`);
    console.log(`  2. docker compose up -d`);
    console.log(`  3. node scripts/squadz.mjs doctor`);
    console.log(`  4. node scripts/bootstrap.mjs --env-file .env`);
  } finally {
    rl?.close();
  }
}

// ---------------------------------------------------------------------------
// doctor / update

function realIo(env) {
  return {
    resolve4: (h) => dns.resolve4(h),
    tcp: (host, port) => new Promise((res) => {
      const s = net.connect({ host, port, timeout: 3000 });
      s.once("connect", () => { s.destroy(); res(true); });
      s.once("error", () => res(false));
      s.once("timeout", () => { s.destroy(); res(false); });
    }),
    cert: (ip, servername) => new Promise((res) => {
      const s = tls.connect({ host: ip, port: 443, servername, timeout: 5000, rejectUnauthorized: false }, () => {
        const c = s.getPeerCertificate();
        const out = { authorized: s.authorized, validTo: c.valid_to };
        s.destroy();
        res(out);
      });
      s.once("error", (e) => res({ error: e.message }));
      s.once("timeout", () => { s.destroy(); res({ error: "TLS handshake timed out" }); });
    }),
    getJson: async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return r.ok ? r.json() : null;
    },
    getStatus: async (url) => (await fetch(url, { signal: AbortSignal.timeout(8000) })).status,
    pushProbe: () => probePushGateway(run, async (u) => (await fetch(u, { signal: AbortSignal.timeout(8000) })).status),
    composePs: () => {
      const r = run("docker", ["compose", "ps", "--format", "json"]);
      if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
      return r.stdout;
    },
  };
}

async function cmdDoctor(flags) {
  loadEnv(flags);
  const results = await runDoctor(process.env, realIo(process.env));
  console.log(formatDoctor(results));
  return results.every((r) => r.ok) ? 0 : 1;
}

async function cmdUpdate(flags) {
  loadEnv(flags);
  must("docker", ["compose", "pull", "--ignore-buildable"], "docker compose pull");
  must("docker", ["compose", "up", "-d", "--build", "--remove-orphans"], "docker compose up");
  console.log("\nRunning doctor...\n");
  return cmdDoctor(flags);
}

// ---------------------------------------------------------------------------
// invite / role / sync-members

async function cmdInvite(flags) {
  loadEnv(flags);
  const log = (m) => console.error(m);
  const config = resolveConfig();
  let token;
  let singleUse = false;
  if (flags.shared) {
    ({ token, singleUse } = await obtainToken({ shared: true, sharedToken: config.registrationToken }));
  } else {
    const { client } = await adminClient(log);
    ({ token, singleUse } = await obtainToken({
      client, userId: config.adminUserId, serverName: config.serverName,
      shared: false, sharedToken: config.registrationToken, log,
    }));
  }
  console.log("\n----- copy from here -----\n");
  console.log(buildInviteMessage({
    chatFqdn: config.serverName, token, singleUse, name: flags.name,
    meshInvite: flags["mesh-invite"], web: !flags["no-web"],
  }));
  console.log("\n----- to here -----");
  if (!singleUse) console.error("\nnote: this is the shared registration token (anyone with it can sign up). Rotate it in .env and `docker compose up -d` once everyone has joined.");
}

async function cmdRole(flags, pos) {
  const [user, role] = pos;
  if (!user || !role) throw new Error(`usage: role <user> ${Object.keys(ROLE_LEVELS).join("|")}`);
  loadEnv(flags);
  const { client, config } = await adminClient();
  const r = await setRole(client, config, user, role, { force: !!flags.force });
  console.log(`${user} -> ${role} (${ROLE_LEVELS[role]}): ${r.changed.length} room(s) updated, ${r.unchanged.length} already correct${r.missing.length ? `, ${r.missing.length} missing (${r.missing.join(", ")})` : ""}.`);
}

async function cmdSyncMembers(flags) {
  loadEnv(flags);
  const { client, config } = await adminClient();
  const users = await listUsers(client, config.adminUserId, config.serverName);
  const r = await syncMembers(client, config, users, (m) => console.error(m));
  console.log(`invited ${r.invited.length} (${r.invited.join(", ") || "none"}); ${r.already.length} already in the Space.`);
}

async function cmdEmoji(flags, pos) {
  const [sub, ...args] = pos;
  if (!["add", "remove", "list"].includes(sub)) throw new Error("usage: emoji <add <shortcode> <image> [--sticker] [--emoji] | remove <shortcode> | list>");
  if (sub === "add" && args.length !== 2) throw new Error("usage: emoji add <shortcode> <image-file> [--sticker] [--emoji]");
  if (sub === "remove" && args.length !== 1) throw new Error("usage: emoji remove <shortcode>");
  if (flags.sticker && flags.emoji) throw new Error("choose either --sticker or --emoji, not both");
  loadEnv(flags);
  const { client, config } = await adminClient();
  if (sub === "add") {
    const [shortcode, file] = args;
    if (!fs.existsSync(file)) throw new Error(`${file} not found`);
    const usage = flags.sticker ? "sticker" : "emoticon";
    const r = await addEmoji(client, config, { shortcode, bytes: fs.readFileSync(file), filename: path.basename(file), usage });
    console.log(`:${shortcode}: added as ${usage === "sticker" ? "sticker" : "emoji"} (${r.info.mimetype} ${r.info.w}x${r.info.h}, ${r.info.size} bytes); pack updated in ${r.changed.length}/${r.targets} room(s).`);
  } else if (sub === "remove") {
    const r = await removeEmoji(client, config, args[0]);
    console.log(r.changed.length ? `:${args[0]}: removed from ${r.changed.length}/${r.targets} room(s).` : `:${args[0]}: not in the pack; nothing to do.`);
  } else {
    const items = await listEmoji(client, config);
    if (!items.length) return console.log("The pack is empty.");
    for (const i of items) console.log(`:${i.shortcode}:	${i.usage.join(",")}	${i.info ? `${i.info.w}x${i.info.h} ${i.info.size ?? "?"}B` : ""}	${i.url}`);
  }
}

// ---------------------------------------------------------------------------
// server show|set

async function cmdServer(flags, pos) {
  const [sub] = pos;
  if (!["show", "set"].includes(sub)) throw new Error("usage: server <show | set [--name STR] [--icon FILE] [--icon-all] [--topic ROOM=TEXT]... [--welcome FILE.md]>");
  const opts = {};
  if (sub === "set") {
    if (flags.name !== undefined) opts.name = flags.name;
    if (flags.icon !== undefined) {
      if (!fs.existsSync(flags.icon)) throw new Error(`${flags.icon} not found`);
      opts.icon = { bytes: fs.readFileSync(flags.icon), filename: path.basename(flags.icon) };
      opts.iconAll = !!flags["icon-all"];
    } else if (flags["icon-all"]) throw new Error("--icon-all needs --icon <file>");
    if (flags.topic) opts.topics = flags.topic.map(parseTopicArg);
    if (flags.welcome !== undefined) {
      if (!fs.existsSync(flags.welcome)) throw new Error(`${flags.welcome} not found`);
      opts.welcome = fs.readFileSync(flags.welcome, "utf8");
      if (!opts.welcome.trim()) throw new Error(`${flags.welcome} is empty`);
    }
    if (!Object.keys(opts).length) throw new Error("nothing to set: pass --name, --icon, --topic or --welcome");
  }
  loadEnv(flags);
  const { client, config } = await adminClient();
  if (sub === "show") {
    const s = await showServer(client, config);
    console.log(`name:     ${s.name ?? "(not set)"}`);
    console.log(`icon:     ${s.avatar ?? "(not set)"}`);
    console.log(`welcome:  ${s.welcomeEventId ?? "(none pinned)"}`);
    console.log("topics:");
    for (const [slug, t] of Object.entries(s.topics)) console.log(`  #${slug}: ${t ?? "(none)"}`);
    return;
  }
  const r = await setServer(client, config, opts);
  console.log(r.changed.length ? `updated: ${r.changed.join(", ")}` : "nothing to change.");
  if (r.unchanged.length) console.log(`already up to date: ${r.unchanged.join(", ")}`);
  if (r.welcome) console.log(`welcome: ${r.welcome.eventId}${r.welcome.posted ? " (posted + pinned)" : " (unchanged)"}`);
}

// ---------------------------------------------------------------------------
// backup / restore (cold: stop tuwunel, tar the volume, start it again)
//
// Tuwunel does have an online RocksDB backup (`!admin server backup-database`,
// needs database_backup_path), but restoring that format needs a different
// procedure; a stopped-DB volume tar is consistent and restores by plain untar.

const HELPER_IMAGE = "alpine:3.20";

function composeVolume(runFn, name) {
  const cfg = runFn("docker", ["compose", "config", "--format", "json"]);
  const project = cfg.status === 0 ? JSON.parse(cfg.stdout).name : null;
  const args = ["volume", "ls", "-q", "--filter", `label=com.docker.compose.volume=${name}`];
  if (project) args.push("--filter", `label=com.docker.compose.project=${project}`);
  const out = runFn("docker", args).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!out.length) throw new Error(`docker volume for "${name}" not found. Has the stack ever been started?`);
  return out[0];
}

function tuwunelRunning(runFn) {
  const r = runFn("docker", ["compose", "ps", "--status", "running", "-q", "tuwunel"]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

export function cmdBackup(flags, deps = {}) {
  const runFn = deps.run ?? run;
  const mustFn = (cmd, args, what) => mustWith(runFn, cmd, args, what);
  const envFile = deps.envFile ?? loadEnv(flags);
  const outDir = path.resolve(root, flags.out ?? "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-backup-"));
  try {
    const volume = composeVolume(runFn, "tuwunel_data");
    const wasRunning = tuwunelRunning(runFn);
    try {
      if (wasRunning) mustFn("docker", ["compose", "stop", "tuwunel"], "stopping tuwunel");
      mustFn("docker", ["run", "--rm", "-v", `${volume}:/data:ro`, "-v", `${stage}:/out`, HELPER_IMAGE, "tar", "czf", "/out/tuwunel-data.tar.gz", "-C", "/data", "."], "snapshotting the tuwunel volume");
    } finally {
      if (wasRunning) mustFn("docker", ["compose", "start", "tuwunel"], "restarting tuwunel");
    }
    fs.copyFileSync(envFile, path.join(stage, "env"));
    fs.cpSync(path.join(root, "config"), path.join(stage, "config"), { recursive: true });
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ created: new Date().toISOString(), volume, tuwunel: "see docker-compose.yml" }, null, 2));
    const file = path.join(outDir, backupFileName());
    mustFn("tar", ["czf", file, "-C", stage, "."], "creating the archive");
    fs.chmodSync(file, 0o600);
    console.log(`Backup written: ${file}\nIt contains .env (secrets): store it somewhere private.`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function cmdRestore(flags, pos, deps = {}) {
  const runFn = deps.run ?? run;
  const mustFn = (cmd, args, what) => mustWith(runFn, cmd, args, what);
  const envFile = deps.envFile ?? resolveEnvFile(flags);
  const file = pos[0];
  if (!file) throw new Error("usage: restore <file.tar.gz> --yes [--with-config]");
  if (!flags.yes) throw new Error("restore replaces the live Tuwunel database. Re-run with --yes to confirm.");
  const archive = path.resolve(file);
  if (!fs.existsSync(archive)) throw new Error(`${archive} not found`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-restore-"));
  try {
    mustFn("tar", ["xzf", archive, "-C", stage], "extracting the archive");
    if (!fs.existsSync(path.join(stage, "tuwunel-data.tar.gz"))) throw new Error("not a squadz backup (tuwunel-data.tar.gz missing)");
    if (flags["with-config"]) {
      fs.copyFileSync(path.join(stage, "env"), envFile);
      fs.chmodSync(envFile, 0o600);
      fs.cpSync(path.join(stage, "config"), path.join(root, "config"), { recursive: true });
      console.log("Restored .env and config/.");
    }
    const volume = composeVolume(runFn, "tuwunel_data");
    mustFn("docker", ["compose", "stop", "tuwunel"], "stopping tuwunel");
    mustFn("docker", ["run", "--rm", "-v", `${volume}:/data`, "-v", `${stage}:/in:ro`, HELPER_IMAGE, "sh", "-c", "find /data -mindepth 1 -delete && tar xzf /in/tuwunel-data.tar.gz -C /data"], "restoring the volume");
    mustFn("docker", ["compose", "up", "-d", "tuwunel"], "starting tuwunel");
    console.log("Restored. Run: node scripts/squadz.mjs doctor");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  if (!cmd || cmd === "-h" || cmd === "--help" || flags.help) return void process.stdout.write(USAGE);
  switch (cmd) {
    case "setup": return cmdSetup(flags);
    case "doctor": return process.exit(await cmdDoctor(flags));
    case "invite": return cmdInvite(flags);
    case "role": return cmdRole(flags, pos);
    case "sync-members": return cmdSyncMembers(flags);
    case "emoji": return cmdEmoji(flags, pos);
    case "server": return cmdServer(flags, pos);
    case "backup": return cmdBackup(flags);
    case "restore": return cmdRestore(flags, pos);
    case "update": return process.exit(await cmdUpdate(flags));
    default: throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`squadz: ${err.message}\n`);
    process.exit(1);
  });
}
