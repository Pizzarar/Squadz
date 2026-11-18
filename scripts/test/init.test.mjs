// `squadz init` (P4 E4): plan, resume/skip, fail-stop hint, mesh CA passing to bootstrap. Fakes for docker + node children.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cmdInit } from "../squadz.mjs";
import { InitError, buildOnboardingSummary, formatInitFailure, runInit } from "../lib/init.mjs";

const PS_ALL = JSON.stringify(["caddy", "tuwunel", "livekit", "lk-jwt-service"].map((Service) => ({ Service, State: "running" })));
const ENV = "SQUADZ_TLS=internal\nCHAT_FQDN=chat.squadz.mesh\nRTC_FQDN=rtc.squadz.mesh\nMESH_IP=100.64.1.1\n";
const INVITE_OUT = "\n----- copy from here -----\n\nHey! token abc\n\n----- to here -----\n";

function fixture({ envText, ca = false, psOut = "", failOn = null, bootstrapped = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadz-init-"));
  const envFile = path.join(dir, ".env");
  if (envText) fs.writeFileSync(envFile, envText);
  if (ca) fs.writeFileSync(path.join(dir, "squadz-ca.crt"), "CERT");
  const calls = [];
  const logs = [];
  const deps = {
    envFile,
    log: (m) => logs.push(String(m)),
    run: (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (args.includes("ps")) return { status: 0, stdout: psOut };
      if (failOn && args.join(" ").includes(failOn)) return { status: 1, stdout: "" };
      return { status: 0, stdout: "" };
    },
    node: (args, o = {}) => {
      const name = path.basename(args[0]) + " " + args.slice(1).filter((a) => !a.startsWith("/") && !/^[A-Za-z]:/.test(a) && !a.includes(".env")).join(" ");
      calls.push(`node ${name.trim()} CA=${o.env?.NODE_EXTRA_CA_CERTS ? "set" : "unset"}`);
      if (args.includes("_probe-bootstrapped")) return { status: bootstrapped ? 0 : 1 };
      if (args.includes("invite")) return { status: 0, stdout: INVITE_OUT };
      return { status: 0, stdout: "" };
    },
    setup: async () => { calls.push("setup"); fs.writeFileSync(envFile, ENV); fs.writeFileSync(path.join(dir, "squadz-ca.crt"), ""); },
    caExport: (f) => { calls.push("ca-export"); fs.writeFileSync(f.out, "CERT"); },
  };
  return { dir, envFile, calls, logs, deps };
}

test("dry-run mesh with no .env: full plan, runs nothing", async () => {
  const f = fixture();
  const code = await cmdInit({ "mesh-only": true, "dry-run": true }, f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.calls, []);
  const out = f.logs.join("\n");
  for (const t of ["[1/8]", "[8/8]", "ca export", "--no-deps caddy", "NODE_EXTRA_CA_CERTS=squadz-ca.crt node scripts/bootstrap.mjs", "restart tuwunel"]) assert.ok(out.includes(t), t);
  assert.equal(fs.existsSync(f.envFile), false);
});

test("dry-run ACME has no caddy/ca steps", async () => {
  const f = fixture();
  await cmdInit({ "dry-run": true }, f.deps);
  const out = f.logs.join("\n");
  assert.match(out, /\[6\/6\]/);
  assert.doesNotMatch(out, /ca export/);
});

test("fresh mesh run: order, CA passed to bootstrap, summary printed", async () => {
  const f = fixture();
  const code = await cmdInit({ "mesh-only": true }, f.deps);
  assert.equal(code, 0);
  const idx = (s) => f.calls.findIndex((c) => c.includes(s));
  assert.ok(idx("setup") < idx("--no-deps caddy") && idx("--no-deps caddy") < idx("ca-export"));
  assert.ok(idx("ca-export") < f.calls.findIndex((c) => c === "docker compose up -d --build"));
  assert.ok(idx("bootstrap.mjs") < idx("restart tuwunel") && idx("restart tuwunel") < idx("doctor") && idx("doctor") < idx("invite"));
  assert.match(f.calls.find((c) => c.includes("bootstrap.mjs")), /CA=set/);
  const out = f.logs.join("\n");
  assert.match(out, /https:\/\/chat\.squadz\.mesh\//);
  assert.match(out, /100\.64\.1\.1 chat\.squadz\.mesh rtc\.squadz\.mesh/);
  assert.match(out, /certutil -user -addstore Root squadz-ca\.crt/);
  assert.match(out, /Hey! token abc/);
});

test("resume: .env + CA + stack up + bootstrapped skips everything but doctor/invite", async () => {
  const f = fixture({ envText: ENV, ca: true, psOut: PS_ALL, bootstrapped: true });
  const code = await cmdInit({}, f.deps);
  assert.equal(code, 0);
  assert.ok(!f.calls.includes("setup") && !f.calls.some((c) => c.includes("bootstrap.mjs") || c.includes("restart") || c.includes("up -d")));
  assert.ok(f.calls.some((c) => c.includes("doctor")) && f.calls.some((c) => c.includes("invite")));
  assert.match(f.logs.join("\n"), /already done, skipping/);
});

test("stops on first failure with exact next command; later steps not run", async () => {
  const f = fixture({ envText: ENV, ca: true, psOut: "", failOn: "up -d --build" });
  const code = await cmdInit({}, f.deps);
  assert.equal(code, 1);
  const out = f.logs.join("\n");
  assert.match(out, /squadz init stopped: step \d\/\d \(Start the full stack\) failed/);
  assert.match(out, /docker compose up -d --build && docker compose logs --tail 50/);
  assert.match(out, /node scripts\/squadz\.mjs init --mesh-only/);
  assert.ok(!f.calls.some((c) => c.includes("bootstrap.mjs")));
});

test("runInit + helpers", async () => {
  const ran = [];
  const steps = [
    { id: "a", title: "A", cmd: "a", run: () => ran.push("a") },
    { id: "b", title: "B", cmd: "b", next: "fix-b", run: () => { throw new Error("boom"); } },
    { id: "c", title: "C", cmd: "c", run: () => ran.push("c") },
  ];
  await assert.rejects(() => runInit({ steps, log: () => {} }), (e) => e instanceof InitError && e.next === "fix-b" && e.step === "b");
  assert.deepEqual(ran, ["a"]);
  assert.match(formatInitFailure(new InitError("x", "b", "fix-b"), "rr"), /fix-b[\s\S]*rr/);
  assert.doesNotMatch(buildOnboardingSummary({ env: { CHAT_FQDN: "c.d", SQUADZ_TLS: "" }, invite: "i", caFile: "x", caInstructions: "" }), /hosts/);
});
