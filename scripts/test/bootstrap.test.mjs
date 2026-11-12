// scripts/test/bootstrap.test.mjs
//
// Idempotency tests for scripts/bootstrap.mjs, run against an in-process mock
// homeserver (node:http). Proves the first run creates everything (admin, space,
// rooms, emoji pack, invites) and a second run creates nothing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockHomeserver } from "./mock-homeserver.mjs";
import { createMatrixClient } from "../lib/matrix.mjs";
import { seed } from "../lib/seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const emojiDir = path.resolve(here, "..", "..", "assets", "emoji");

const SERVER_NAME = "chat.squadz.test";
const REG_TOKEN = "test-token";

const mock = createMockHomeserver({ serverName: SERVER_NAME, registrationToken: REG_TOKEN });
let baseUrl;

function makeConfig() {
  return {
    serverName: SERVER_NAME,
    homeserverUrl: baseUrl,
    registrationToken: REG_TOKEN,
    adminUser: "admin",
    adminUserId: `@admin:${SERVER_NAME}`,
    adminPassword: "admin-password",
    invite: [`@friend:${SERVER_NAME}`],
    emojiDir,
  };
}

function roomBySlug(slug) {
  const alias = `#${slug}:${SERVER_NAME}`;
  const roomId = mock.state.aliases.get(alias);
  return roomId ? mock.state.rooms.get(roomId) : undefined;
}

function stateOf(room, type, stateKey) {
  return room.state.get(`${type}\u0000${stateKey}`);
}

before(async () => {
  const port = await mock.start();
  baseUrl = mock.url(port);
});

after(async () => {
  await mock.stop();
});

test("first run creates everything", async () => {
  const client = createMatrixClient(baseUrl);
  const summary = await seed(client, makeConfig());

  assert.equal(summary.admin.registered, true, "admin should be registered on first run");
  assert.equal(summary.createdRooms, 6, "six child rooms should be created");
  assert.equal(summary.emoji.uploaded, 4, "four emoji PNGs should be uploaded");
  assert.equal(summary.emoji.set, true, "emoji pack should be set");
  assert.equal(summary.invited, 7, "friend invited to space + six rooms");

  // The mock saw the space creation too. The UIA registration flow hits
  // /register twice (challenge + token), and the admin logs in once first.
  assert.equal(mock.state.counts.createRoom, 7, "space + six rooms");
  assert.ok(mock.state.counts.register >= 1, "a registration happened");
  assert.ok(mock.state.counts.login >= 1, "an initial login attempt happened");
  assert.equal(mock.state.counts.upload, 4);
});

// Mutation counters that a second run must NOT touch. `login` is deliberately
// excluded: logging back in as the existing admin is not "creating" anything.
const MUTATIONS = ["createRoom", "register", "upload", "invite", "putState"];

test("second run creates nothing", async () => {
  const before2 = {};
  for (const key of MUTATIONS) before2[key] = mock.state.counts[key];

  const client = createMatrixClient(baseUrl);
  const summary = await seed(client, makeConfig());

  assert.equal(summary.admin.registered, false, "admin already exists, so no registration");
  assert.equal(summary.createdRooms, 0, "no rooms created on second run");
  assert.equal(summary.emoji.uploaded, 0, "no media uploaded on second run");
  assert.equal(summary.emoji.set, false, "emoji pack left untouched");
  assert.equal(summary.invited, 0, "friend already invited, nothing to do");

  for (const key of MUTATIONS) {
    assert.equal(mock.state.counts[key], before2[key], `no ${key} on the second run`);
  }
});

test("space and rooms are linked with m.space.child / m.space.parent", async () => {
  const space = roomBySlug("squadz");
  assert.ok(space, "space exists");

  const slugs = ["general", "games", "clips", "memes", "lounge", "game-night"];
  for (let i = 0; i < slugs.length; i++) {
    const room = roomBySlug(slugs[i]);
    assert.ok(room, `${slugs[i]} room exists`);

    // Space -> child
    const child = stateOf(space, "m.space.child", room.roomId);
    assert.ok(child, `space has m.space.child for ${slugs[i]}`);
    assert.deepEqual(child.via, [SERVER_NAME]);

    // Child -> space (canonical)
    const parent = stateOf(room, "m.space.parent", space.roomId);
    assert.ok(parent, `${slugs[i]} has m.space.parent`);
    assert.equal(parent.canonical, true);
    assert.deepEqual(parent.via, [SERVER_NAME]);
  }
});

test("voice rooms are MatrixRTC call rooms; #clips is unencrypted for the bot", async () => {
  const RTC_SLOT = "org.matrix.msc4143.rtc.slot";

  for (const slug of ["lounge", "game-night"]) {
    const room = roomBySlug(slug);
    const slot = stateOf(room, RTC_SLOT, "m.call#ROOM");
    assert.ok(slot, `${slug} has an open MatrixRTC slot`);
    assert.equal(slot.status, "open");
    assert.equal(slot.application?.type, "m.call");
    assert.equal(slot.encryption?.type, "org.matrix.msc4143.per_member");

    assert.ok(stateOf(room, "m.room.encryption", ""), `${slug} is encrypted`);
  }

  for (const slug of ["general", "games", "memes"]) {
    assert.ok(stateOf(roomBySlug(slug), "m.room.encryption", ""), `${slug} is encrypted`);
  }

  assert.equal(stateOf(roomBySlug("clips"), "m.room.encryption", ""), undefined, "#clips is unencrypted");
});

test("emoji pack is set on the Space (MSC2545 im.ponies.room_emotes)", async () => {
  const space = roomBySlug("squadz");
  const pack = stateOf(space, "im.ponies.room_emotes", "");
  assert.ok(pack, "emoji pack exists");
  const shortcodes = Object.keys(pack);
  assert.deepEqual(shortcodes.sort(), ["gg", "party", "squadz", "wave"]);
  for (const code of shortcodes) {
    assert.ok(pack[code].url.startsWith("mxc://"), `${code} has an mxc url`);
    assert.equal(pack[code].info.mimetype, "image/png");
  }
});

test("room aliases resolve to the seeded rooms", async () => {
  const client = createMatrixClient(baseUrl);
  for (const slug of ["squadz", "general", "games", "clips", "memes", "lounge", "game-night"]) {
    const roomId = await client.resolveAlias(`#${slug}:${SERVER_NAME}`);
    assert.ok(roomId, `#${slug} resolves`);
    assert.equal(mock.state.aliases.get(`#${slug}:${SERVER_NAME}`), roomId);
  }
});
