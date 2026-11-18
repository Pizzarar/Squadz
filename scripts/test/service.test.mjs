// scripts/test/service.test.mjs
//
// systemd unit generation, backup retention and the doctor freshness checks.
// Pure / temp-dir only: no systemd, no docker, runs on the Windows dev PC.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildServiceUnits, checkBackupFreshness, checkServiceEnabled, formatDoctor, isBackupFile,
  parseBackupTime, parseKeep, runDoctor, selectBackupsToPrune,
} from "../lib/ops.mjs";
import { cmdService, pruneBackups } from "../squadz.mjs";

const opts = { repoDir: "/srv/squadz", nodePath: "/usr/bin/node" };

test("units: squadz.service is a oneshot RemainAfterExit running compose up -d after docker + network-online", () => {
  const u = buildServiceUnits(opts)["squadz.service"];
  assert.match(u, /^Type=oneshot$/m);
  assert.match(u, /^RemainAfterExit=yes$/m);
  assert.match(u, /^WorkingDirectory=\/srv\/squadz$/m);
  assert.match(u, /^ExecStart=\/usr\/bin\/docker compose up -d$/m);
  assert.match(u, /^After=docker\.service network-online\.target$/m);
  assert.match(u, /^Wants=network-online\.target$/m);
  assert.match(u, /^WantedBy=multi-user\.target$/m);
});

test("units: backup service + timer defaults (04:00, Persistent, keep 14)", () => {
  const u = buildServiceUnits(opts);
  assert.deepEqual(Object.keys(u), ["squadz.service", "squadz-backup.service", "squadz-backup.timer"]);
  assert.match(u["squadz-backup.service"], /^ExecStart=\/usr\/bin\/node \/srv\/squadz\/scripts\/squadz\.mjs backup --keep 14$/m);
  assert.match(u["squadz-backup.service"], /^Type=oneshot$/m);
  assert.match(u["squadz-backup.timer"], /^OnCalendar=\*-\*-\* 04:00:00$/m);
  assert.match(u["squadz-backup.timer"], /^Persistent=true$/m);
  assert.match(u["squadz-backup.timer"], /^WantedBy=timers\.target$/m);
});

test("units: --backup-at and --keep are honoured, paths with spaces are quoted, output is deterministic", () => {
  const o = { repoDir: "/srv/my squadz", nodePath: "/usr/bin/node", backupAt: "3:05", keep: 7 };
  const u = buildServiceUnits(o);
  assert.match(u["squadz-backup.timer"], /OnCalendar=\*-\*-\* 03:05:00/);
  assert.match(u["squadz-backup.service"], /backup --keep 7$/m);
  assert.match(u["squadz-backup.service"], /"\/srv\/my squadz\/scripts\/squadz\.mjs"/);
  assert.deepEqual(buildServiceUnits(o), u);
});

test("units: WorkingDirectory stays unquoted (systemd does not strip quotes there), ExecStart stays quoted", () => {
  const u = buildServiceUnits({ repoDir: "/srv/my squadz", nodePath: "/usr/bin/node" });
  assert.match(u["squadz.service"], /^WorkingDirectory=\/srv\/my squadz$/m);
  assert.match(u["squadz-backup.service"], /^WorkingDirectory=\/srv\/my squadz$/m);
  // the path goes through ExecStart as one quoted argument
  assert.match(u["squadz-backup.service"], /^ExecStart=\/usr\/bin\/node "\/srv\/my squadz\/scripts\/squadz\.mjs" backup --keep 14$/m);
});

test("units: % is doubled as %% in every interpolated value (systemd specifier escape)", () => {
  const u = buildServiceUnits({ repoDir: "/srv/100% squadz", nodePath: "/opt/node%20/bin/node" });
  assert.match(u["squadz.service"], /^WorkingDirectory=\/srv\/100%% squadz$/m);
  assert.match(u["squadz-backup.service"], /^WorkingDirectory=\/srv\/100%% squadz$/m);
  assert.match(u["squadz-backup.service"], /^ExecStart=\/opt\/node%%20\/bin\/node "\/srv\/100%% squadz\/scripts\/squadz\.mjs" backup --keep 14$/m);
  // no lone % survives in any unit: every one must be part of a %%
  for (const [name, text] of Object.entries(u)) {
    assert.equal((text.match(/(?<!%)%(?!%)/g) ?? []).length, 0, `${name} has a lone %`);
  }
});

test("units: paths systemd cannot represent are rejected with a clear error", () => {
  const base = { repoDir: "/srv/squadz", nodePath: "/usr/bin/node" };
  for (const bad of ["/srv/a\nb", "/srv/a\rb"]) {
    assert.throws(() => buildServiceUnits({ ...base, repoDir: bad }), /repoDir: a newline cannot be written to a systemd unit/);
  }
  assert.throws(() => buildServiceUnits({ ...base, repoDir: "/srv/a\0b" }), /repoDir: a NUL byte cannot be written/);
  assert.throws(() => buildServiceUnits({ ...base, repoDir: "/srv/a\tb" }), /repoDir: control characters cannot be written/);
  assert.throws(() => buildServiceUnits({ ...base, nodePath: "/usr/bin/no\nde" }), /nodePath: a newline cannot be written/);
  assert.throws(() => buildServiceUnits({ ...base, repoDir: "" }), /repoDir: refusing an empty value/);
  assert.throws(() => buildServiceUnits({ ...base, nodePath: "-node" }), /nodePath: must not start with "-"/);
});

test("units: relative paths are rejected (systemd would resolve them against its own cwd)", () => {
  const base = { repoDir: "/srv/squadz", nodePath: "/usr/bin/node" };
  assert.throws(() => buildServiceUnits({ ...base, repoDir: "srv/squadz" }), /repoDir: must be an absolute path "srv\/squadz"/);
  assert.throws(() => buildServiceUnits({ ...base, nodePath: "usr/bin/node" }), /nodePath: must be an absolute path/);
  assert.throws(() => buildServiceUnits({ ...base, dockerPath: "bin/docker" }), /dockerPath: must be an absolute path/);
  assert.throws(() => buildServiceUnits({ ...base, dockerPath: "./docker" }), /dockerPath: must be an absolute path/);
});

test("parseBackupTime / parseKeep validate input", () => {
  assert.equal(parseBackupTime(undefined), "04:00");
  assert.equal(parseBackupTime("23:59"), "23:59");
  for (const bad of ["24:00", "4", "12:60", "noon", "04:0"]) assert.throws(() => parseBackupTime(bad), /HH:MM/);
  assert.equal(parseKeep(undefined), 14);
  assert.equal(parseKeep("3"), 3);
  for (const bad of ["0", "-1", "x", "1.5", true === 0]) assert.throws(() => parseKeep(bad), /--keep/);
});

test("prune: only exact squadz-backup-*.tar.gz names, oldest beyond N", () => {
  const names = [
    "squadz-backup-20260101-040000.tar.gz",
    "squadz-backup-20260103-040000.tar.gz",
    "squadz-backup-20260102-040000.tar.gz",
    "squadz-backup-20260104-040000.tar.gz",
    "squadz-backup-20260104-040000.tar.gz.bak", // wrong suffix
    "my-squadz-backup-20250101-000000.tar.gz",  // wrong prefix
    "squadz-backup-latest.tar.gz",              // not a timestamp
    "notes.txt",
  ];
  assert.deepEqual(selectBackupsToPrune(names, 2), ["squadz-backup-20260101-040000.tar.gz", "squadz-backup-20260102-040000.tar.gz"]);
  assert.deepEqual(selectBackupsToPrune(names, 4), []);
  assert.deepEqual(selectBackupsToPrune(names, 99), []);
  assert.deepEqual(selectBackupsToPrune([], 1), []);
  assert.ok(!isBackupFile("squadz-backup-20260101-040000.tar.gz.bak"));
});

test("pruneBackups deletes only the selected files on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-prune-"));
  try {
    const keepMe = ["README.txt", "other.tar.gz", "squadz-backup-20260105-040000.tar.gz", "squadz-backup-20260106-040000.tar.gz"];
    const old = ["squadz-backup-20260101-040000.tar.gz", "squadz-backup-20260102-040000.tar.gz"];
    for (const n of [...keepMe, ...old]) fs.writeFileSync(path.join(dir, n), "x");
    assert.deepEqual(pruneBackups(dir, 2), old);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...keepMe].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: service-enabled check warns, never fails", () => {
  const on = checkServiceEnabled("enabled\n");
  assert.equal(on.ok, true); assert.ok(!on.warn);
  for (const state of ["disabled", "", "masked"]) {
    const r = checkServiceEnabled(state);
    assert.equal(r.ok, true); assert.equal(r.warn, true); assert.match(r.fix, /service install/);
  }
  const none = checkServiceEnabled(null);
  assert.equal(none.ok, true); assert.equal(none.warn, true);
});

test("doctor: backup freshness (48h boundary, ignores non-backup files, none = warn)", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const h = (n) => now.getTime() - n * 3600000;
  const f = (name, hrs) => ({ name, mtimeMs: h(hrs) });
  assert.ok(!checkBackupFreshness([f("squadz-backup-20261118-040000.tar.gz", 8)], now).warn);
  assert.ok(!checkBackupFreshness([f("squadz-backup-20261116-120000.tar.gz", 48)], now).warn);
  const stale = checkBackupFreshness([f("squadz-backup-20261110-040000.tar.gz", 49), f("squadz-backup-20261101-040000.tar.gz", 400)], now);
  assert.equal(stale.ok, true); assert.equal(stale.warn, true); assert.match(stale.detail, /49h old/);
  // a fresh non-backup file must not count
  assert.equal(checkBackupFreshness([f("fresh.txt", 1), f("squadz-backup-20261101-040000.tar.gz", 400)], now).warn, true);
  const none = checkBackupFreshness([], now);
  assert.equal(none.warn, true); assert.match(none.detail, /no backups/);
});

test("runDoctor adds warnings that do not fail the run; formatDoctor prints WARN", async () => {
  const io = {
    resolve4: async () => ["10.0.0.1"], tcp: async () => true,
    cert: async () => ({ authorized: true, validTo: "2099-01-01" }),
    getJson: async (u) => (u.includes("well-known")
      ? { "m.homeserver": { base_url: "https://c.example" }, "org.matrix.msc4143.rtc_foci": [{ type: "livekit", livekit_service_url: "https://r.example/livekit/jwt" }] }
      : { versions: ["v1.1"] }),
    getStatus: async () => 200,
    composePs: async () => ["caddy", "tuwunel", "livekit", "lk-jwt-service"].map((s) => JSON.stringify({ Service: s, State: "running" })).join("\n"),
    serviceState: async () => "disabled",
    backupFiles: async () => [],
  };
  const env = { CHAT_FQDN: "c.example", RTC_FQDN: "r.example", MESH_IP: "10.0.0.1" };
  const res = await runDoctor(env, io);
  assert.ok(res.every((r) => r.ok));
  assert.equal(res.filter((r) => r.warn).length, 2);
  const text = formatDoctor(res);
  assert.match(text, /^WARN squadz\.service enabled/m);
  assert.match(text, /\(2 warnings\)/);
});

// ---- cmdService (fake run / fs targets) ----

function harness(extra = {}) {
  const calls = [];
  const logs = [];
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-units-"));
  const deps = {
    platform: "linux", systemd: true, isRoot: true, unitDir, repoDir: "/srv/squadz", nodePath: "/usr/bin/node",
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      // emulate `sudo install -m 644 <tmp> <target>` / plain root writes
      const a = cmd === "sudo" ? args : [cmd, ...args];
      if (a[0] === "install") fs.copyFileSync(a[3], a[4]);
      if (a[0] === "rm") fs.rmSync(a[2], { force: true });
      return { status: 0, stdout: "enabled\n" };
    },
    log: (m) => logs.push(m),
    ...extra,
  };
  return { deps, calls, logs, unitDir, done: () => fs.rmSync(unitDir, { recursive: true, force: true }) };
}

test("service install --dry-run prints units and never runs anything, even off Linux", () => {
  const h = harness({ platform: "win32", systemd: false });
  try {
    cmdService({ "dry-run": true }, ["install"], h.deps);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(fs.readdirSync(h.unitDir), []);
    assert.match(h.logs.join("\n"), /squadz-backup\.timer[\s\S]*Persistent=true/);
  } finally { h.done(); }
});

test("service refuses off Linux and without systemd, with a clear message", () => {
  const w = harness({ platform: "win32" });
  assert.throws(() => cmdService({}, ["install"], w.deps), /needs Linux with systemd \(this is win32\)/);
  assert.equal(w.calls.length, 0); w.done();
  const n = harness({ systemd: false });
  assert.throws(() => cmdService({}, ["status"], n.deps), /systemd is not running/);
  assert.equal(n.calls.length, 0); n.done();
  assert.throws(() => cmdService({}, ["bogus"], n.deps), /usage: service/);
});

test("service install as root writes units, enables, is idempotent on re-run", () => {
  const h = harness();
  try {
    cmdService({ "backup-at": "02:30", keep: "5" }, ["install"], h.deps);
    assert.deepEqual(fs.readdirSync(h.unitDir).sort(), ["squadz-backup.service", "squadz-backup.timer", "squadz.service"]);
    assert.match(fs.readFileSync(path.join(h.unitDir, "squadz-backup.timer"), "utf8"), /02:30:00/);
    assert.ok(h.calls.includes("systemctl daemon-reload"));
    assert.ok(h.calls.includes("systemctl enable squadz.service squadz-backup.timer"));
    assert.ok(h.calls.every((c) => !c.startsWith("sudo")));
    h.logs.length = 0;
    cmdService({ "backup-at": "02:30", keep: "5" }, ["install"], h.deps);
    assert.equal(h.logs.filter((l) => l.startsWith("unchanged:")).length, 3);
    assert.equal(h.logs.filter((l) => l.startsWith("wrote:")).length, 0);
  } finally { h.done(); }
});

test("service install as non-root goes through sudo; uninstall removes the units", () => {
  const h = harness({ isRoot: false });
  try {
    cmdService({}, ["install"], h.deps);
    assert.ok(h.calls.some((c) => c.startsWith("sudo install -m 644")));
    assert.ok(h.calls.includes("sudo systemctl daemon-reload"));
    cmdService({}, ["uninstall"], h.deps);
    assert.deepEqual(fs.readdirSync(h.unitDir), []);
    assert.ok(h.calls.some((c) => c.startsWith("sudo systemctl disable --now")));
  } finally { h.done(); }
});
