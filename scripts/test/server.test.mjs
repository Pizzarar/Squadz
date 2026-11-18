// scripts/test/server.test.mjs: `squadz server` + welcome against the mock homeserver.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockHomeserver } from "./mock-homeserver.mjs";
import { createMatrixClient } from "../lib/matrix.mjs";
import { seed } from "../lib/seed.mjs";
import {
  markdownToHtml, parseTopicArg, postWelcome, setServer, showServer, welcomeContent,
} from "../lib/server.mjs";

const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = "chat.squadz.test";
const mock = createMockHomeserver({ serverName: SERVER, registrationToken: "t" });
let client;
let config;
const room = (slug) => mock.state.rooms.get(mock.state.aliases.get(`#${slug}:${SERVER}`));
const st = (slug, type) => room(slug).state.get(`${type}\u0000`);

before(async () => {
  const port = await mock.start();
  config = {
    serverName: SERVER, homeserverUrl: mock.url(port), registrationToken: "t",
    adminUser: "admin", adminUserId: `@admin:${SERVER}`, adminPassword: "pw",
    invite: [], emojiDir: path.resolve(here, "..", "..", "assets", "emoji"),
  };
  client = createMatrixClient(config.homeserverUrl);
  await seed(client, config);
});
after(() => mock.stop());

test("markdownToHtml: headings, lists, bold/italic/code, escaping, paragraphs", () => {
  const html = markdownToHtml("# Hi <b>\n\nsome **bold** and *it* and `x`\nnext line\n\n- a\n- b\n");
  assert.equal(
    html,
    "<h1>Hi &lt;b&gt;</h1><p>some <strong>bold</strong> and <em>it</em> and <code>x</code><br>next line</p><ul><li>a</li><li>b</li></ul>",
  );
  const c = welcomeContent("hello\r\n");
  assert.equal(c.msgtype, "m.notice");
  assert.equal(c.body, "hello");
  assert.equal(c.formatted_body, "<p>hello</p>");
});

test("parseTopicArg: slug=text, #slug allowed, unknown room and missing = rejected", () => {
  assert.deepEqual(parseTopicArg("general=Chat = here"), { slug: "general", text: "Chat = here" });
  assert.deepEqual(parseTopicArg("#games=GG"), { slug: "games", text: "GG" });
  assert.throws(() => parseTopicArg("nope=x"), /unknown room/);
  assert.throws(() => parseTopicArg("general"), /expects/);
});

test("setServer: name + topics are idempotent", async () => {
  const opts = { name: "Our Squad", topics: [{ slug: "general", text: "Chat here" }, { slug: "clips", text: "Clips!" }] };
  const a = await setServer(client, config, opts);
  assert.deepEqual(a.changed, ["name", "topic:general", "topic:clips"]);
  assert.deepEqual(st("squadz", "m.room.name"), { name: "Our Squad" });
  assert.deepEqual(st("general", "m.room.topic"), { topic: "Chat here" });
  const puts = mock.state.counts.putState;
  const b = await setServer(client, config, opts);
  assert.deepEqual(b.changed, []);
  assert.equal(b.unchanged.length, 3);
  assert.equal(mock.state.counts.putState, puts, "no state writes on re-run");
  await assert.rejects(setServer(client, config, { name: "  " }), /empty/);
});

test("setServer --icon uploads once, sets Space avatar; --icon-all hits every room", async () => {
  const icon = { bytes: png(64, 64), filename: "i.png" };
  const uploads = mock.state.counts.upload;
  const a = await setServer(client, config, { icon });
  assert.deepEqual(a.changed, ["icon"]);
  const av = st("squadz", "m.room.avatar");
  assert.match(av.url, /^mxc:\/\//);
  assert.deepEqual(av.info, { w: 64, h: 64, size: 33, mimetype: "image/png" });
  assert.equal(st("general", "m.room.avatar"), undefined);
  const b = await setServer(client, config, { icon });
  assert.deepEqual(b.changed, []);
  assert.equal(mock.state.counts.upload, uploads + 1, "same bytes are not re-uploaded");
  const c = await setServer(client, config, { icon, iconAll: true });
  assert.equal(c.changed.length, 6, "6 rooms besides the Space");
  assert.equal(mock.state.counts.upload, uploads + 1);
  for (const slug of ["general", "lounge", "game-night"]) assert.equal(st(slug, "m.room.avatar").url, av.url);
  await assert.rejects(setServer(client, config, { icon: { bytes: Buffer.from("GIF89a\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0") } }), /png, jpg or webp/);
  await assert.rejects(setServer(client, config, { icon: { bytes: Buffer.from("junk") } }), /png, jpg or webp/);
});

test("welcome: posts notice with body + formatted_body, pins, replaces rather than stacks", async () => {
  const a = await setServer(client, config, { welcome: "# Hello\n\n- one\n- **two**" });
  assert.equal(a.welcome.posted, true);
  const tl = room("general").timeline;
  const msg = tl.find((e) => e.event_id === a.welcome.eventId);
  assert.equal(msg.content.msgtype, "m.notice");
  assert.equal(msg.content.body, "# Hello\n\n- one\n- **two**");
  assert.equal(msg.content.formatted_body, "<h1>Hello</h1><ul><li>one</li><li><strong>two</strong></li></ul>");
  assert.deepEqual(st("general", "m.room.pinned_events"), { pinned: [a.welcome.eventId] });

  const msgs = tl.length;
  const b = await setServer(client, config, { welcome: "# Hello\n\n- one\n- **two**\n" });
  assert.equal(b.welcome.posted, false);
  assert.equal(room("general").timeline.length, msgs, "identical text posts nothing");

  // Another pin made by hand survives a welcome replacement.
  room("general").state.set("m.room.pinned_events\u0000", { pinned: ["$other", a.welcome.eventId] });
  const c = await setServer(client, config, { welcome: "changed" });
  assert.equal(c.welcome.posted, true);
  assert.deepEqual(st("general", "m.room.pinned_events"), { pinned: ["$other", c.welcome.eventId] });
  assert.equal(c.welcome.replaced, a.welcome.eventId);
});

test("showServer: name, avatar, topics, pinned welcome id", async () => {
  const s = await showServer(client, config);
  assert.equal(s.name, "Our Squad");
  assert.match(s.avatar, /^mxc:\/\//);
  assert.equal(s.topics.general, "Chat here");
  assert.equal(s.topics.memes, null);
  assert.equal(s.welcomeEventId, st("general", "dev.squadz.welcome").event_id);
});

test("postWelcome onlyIfMissing (bootstrap path): seeds once, never overwrites; shipped welcome.md covers the brief", async () => {
  const mock2 = createMockHomeserver({ serverName: SERVER, registrationToken: "t" });
  const port = await mock2.start();
  try {
    const cfg = { ...config, homeserverUrl: mock2.url(port) };
    const c2 = createMatrixClient(cfg.homeserverUrl);
    await seed(c2, cfg);
    const md = fs.readFileSync(path.resolve(here, "..", "..", "config", "welcome.md"), "utf8");
    for (const needle of [/rules/i, /Lounge/, /voice/i, /!sb play/, /emoji/i, /General/, /Clips/]) assert.match(md, needle);
    const a = await postWelcome(c2, cfg, md, { onlyIfMissing: true });
    assert.equal(a.posted, true);
    const b = await postWelcome(c2, cfg, "host edited text", { onlyIfMissing: true });
    assert.equal(b.posted, false);
    assert.equal(b.eventId, a.eventId);
    const general = mock2.state.rooms.get(mock2.state.aliases.get(`#general:${SERVER}`));
    assert.equal(general.timeline.length, 1);
  } finally {
    await mock2.stop();
  }
});

test("CLI parseArgs: repeated --topic collects into an array; other flags still work", async () => {
  const { parseArgs } = await import("../squadz.mjs");
  const { flags, pos } = parseArgs(["server", "set", "--name", "X", "--topic", "general=A b", "--topic=clips=C=D", "--icon-all"]);
  assert.deepEqual(pos, ["server", "set"]);
  assert.deepEqual(flags.topic, ["general=A b", "clips=C=D"]);
  assert.equal(flags.name, "X");
  assert.equal(flags["icon-all"], true);
  assert.deepEqual(flags.topic.map(parseTopicArg), [{ slug: "general", text: "A b" }, { slug: "clips", text: "C=D" }]);
  assert.throws(() => parseArgs(["--topic"]), /requires a value/);
});
