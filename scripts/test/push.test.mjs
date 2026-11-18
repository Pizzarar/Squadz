// scripts/test/push.test.mjs: scripts/lib/push.mjs (block D5) and its wiring into runDoctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUSH_GATEWAY_URL, checkPushGateway, parseHttpStatus, probePushGateway } from "../lib/push.mjs";
import { runDoctor } from "../lib/ops.mjs";

const hostOk = async () => 405;

test("parseHttpStatus", () => {
  assert.equal(parseHttpStatus("405"), 405);
  assert.equal(parseHttpStatus(""), 0);
  assert.equal(parseHttpStatus("000"), 0);
});

test("probe prefers curl inside the container", async () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "405" }; };
  assert.deepEqual(await probePushGateway(run, hostOk), { via: "container", status: 405 });
  assert.match(calls[0], /compose exec -T tuwunel curl .*matrix\.org\/_matrix\/push\/v1\/notify/);
});

test("probe falls back to wget (busybox stderr), then to the host", async () => {
  const wget = (cmd, args) => (args.includes("curl") ? { status: 126, stdout: "", stderr: "not found" } : { status: 1, stderr: "  HTTP/1.1 405 Method Not Allowed" });
  assert.deepEqual(await probePushGateway(wget, hostOk), { via: "container", status: 405 });
  const none = () => ({ status: 126, stdout: "", stderr: "executable file not found" });
  assert.deepEqual(await probePushGateway(none, hostOk), { via: "host", status: 405 });
});

test("checkPushGateway", () => {
  assert.equal(checkPushGateway({ via: "container", status: 405 }).ok, true);
  assert.match(checkPushGateway({ via: "host", status: 405 }).detail, /host only/);
  const bad = checkPushGateway({ via: "host", status: 0 });
  assert.equal(bad.ok, false);
  assert.ok(bad.fix.includes("matrix.org") && PUSH_GATEWAY_URL.includes("matrix.org"));
  assert.equal(checkPushGateway(null).ok, false);
});

test("runDoctor includes the push check only when io.pushProbe is supplied", async () => {
  const io = { resolve4: async () => [], tcp: async () => false, cert: async () => null, getJson: async () => null, getStatus: async () => 0, composePs: async () => "" };
  const env = { CHAT_FQDN: "chat.x.test", RTC_FQDN: "rtc.x.test", MESH_IP: "100.64.0.1" };
  const without = await runDoctor(env, io);
  const withPush = await runDoctor(env, { ...io, pushProbe: async () => ({ via: "container", status: 405 }) });
  assert.equal(withPush.length, without.length + 1);
  assert.equal(withPush.at(-1).ok, true);
});
