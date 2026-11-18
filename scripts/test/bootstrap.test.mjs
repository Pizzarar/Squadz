// scripts/test/bootstrap.test.mjs
//
// Idempotency tests for scripts/bootstrap.mjs, run against an in-process mock
// homeserver (node:http). Proves the first run creates everything (admin, space,
// rooms, emoji pack, invites) and a second run creates nothing, plus the review
// fixes: image-pack emoji format, key-order-insensitive state compare, call
// power levels, restricted join rules, multi-stage UIA and invite skipping.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockHomeserver } from "./mock-homeserver.mjs";
import { createMatrixClient } from "../lib/matrix.mjs";
import { seed } from "../lib/seed.mjs";
import { toUserId, toLocalpart, resolveConfig } from "../lib/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const emojiDir = path.resolve(here, "..", "..", "assets", "emoji");

const SERVER_NAME = "chat.squadz.test";
const REG_TOKEN = "test-token";

const mock = createMockHomeserver({ serverName: SERVER_NAME, registrationToken: REG_TOKEN });
let baseUrl;

function makeConfig(invite = [`@friend:${SERVER_NAME}`]) {
  return {
    serverName: SERVER_NAME,
    homeserverUrl: baseUrl,
    registrationToken: REG_TOKEN,
    adminUser: "admin",
    adminUserId: `@admin:${SERVER_NAME}`,
    adminPassword: "admin-password",
    invite,
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
  // The friend being invited must already have an account on the server.
  mock.state.users.set("friend", { password: "friend-password" });
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
  assert.equal(summary.emoji.set, 5, "emoji pack set on the Space + four text rooms");
  assert.equal(summary.invited, 1, "friend invited to the Space only (rooms are restricted)");

  // The mock saw the space creation too. The multi-stage UIA registration hits
  // /register three times (challenge + registration_token + dummy), and the
  // admin logs in once first.
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
  assert.equal(summary.emoji.set, 0, "emoji pack left untouched");
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

test("child rooms use restricted join rules allowing Space membership", () => {
  const space = roomBySlug("squadz");
  const slugs = ["general", "games", "clips", "memes", "lounge", "game-night"];
  for (const slug of slugs) {
    const room = roomBySlug(slug);
    const joinRules = stateOf(room, "m.room.join_rules", "");
    assert.equal(joinRules.join_rule, "restricted", `${slug} is restricted`);
    assert.deepEqual(joinRules.allow, [{ type: "m.room_membership", room_id: space.roomId }]);
  }
  // The Space itself is joined via invite, not restricted.
  assert.equal(stateOf(space, "m.room.join_rules", "").join_rule, "public", "space is public so auto_join_rooms can join it");
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

test("call-membership events are allowed (level 0) in voice rooms and #clips", () => {
  const CALL_EVENTS = [
    "org.matrix.msc3401.call.member",
    "org.matrix.msc4143.rtc.member",
    "m.rtc.member",
  ];
  for (const slug of ["lounge", "game-night", "clips"]) {
    const room = roomBySlug(slug);
    const pl = stateOf(room, "m.room.power_levels", "");
    for (const ev of CALL_EVENTS) {
      assert.equal(pl.events[ev], 0, `${slug} allows ${ev} at 0`);
    }
  }
  // A text room that doesn't host calls gets no call-membership override.
  assert.equal(
    stateOf(roomBySlug("general"), "m.room.power_levels", "").events["org.matrix.msc4143.rtc.member"],
    undefined,
    "general has no call-member override",
  );
});

test("emoji pack uses MSC2545 image-pack format on the Space and text rooms", async () => {
  const space = roomBySlug("squadz");
  for (const slug of ["squadz", "general", "games", "clips", "memes"]) {
    const room = roomBySlug(slug);
    const pack = stateOf(room, "im.ponies.room_emotes", "");
    assert.ok(pack, `emoji pack exists on ${slug}`);
    assert.equal(pack.pack?.display_name, "Squadz", `${slug} pack has a display_name`);
    assert.deepEqual(pack.pack?.usage, ["emoticon"], `${slug} pack usage is emoticon`);
    assert.ok(pack.images, `${slug} pack has an images map`);
    const shortcodes = Object.keys(pack.images);
    assert.deepEqual(shortcodes.sort(), ["gg", "party", "squadz", "wave"]);
    for (const code of shortcodes) {
      const image = pack.images[code];
      assert.ok(image.url.startsWith("mxc://"), `${code} has an mxc url`);
      assert.equal(image.body, code, `${code} body is the shortcode`);
      assert.equal(image.info.mimetype, "image/png");
      assert.equal(image.usage, undefined, `${code} has no per-image usage (usage is on the pack)`);
    }
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

test("setStateIfChanged ignores key order (no PUT when state matches)", async () => {
  const space = roomBySlug("squadz");
  const general = roomBySlug("general");
  // Reorder the stored m.space.child content so JSON.stringify would differ
  // but the value is semantically identical.
  const key = `m.space.child\u0000${general.roomId}`;
  const original = space.state.get(key);
  space.state.set(key, { order: original.order, suggested: original.suggested, via: original.via });

  const before = mock.state.counts.putState;
  const client = createMatrixClient(baseUrl);
  await seed(client, makeConfig());
  assert.equal(mock.state.counts.putState, before, "no PUT for a state that differs only in key order");
});

test("registration completes the multi-stage UIA flow (token then dummy)", async () => {
  const client = createMatrixClient(baseUrl);
  const result = await client.register("carol", "carol-password", REG_TOKEN);
  assert.equal(result.user_id, `@carol:${SERVER_NAME}`);
  assert.ok(result.access_token, "registration returns an access token");

  const stages = mock.state.registerStages.filter((s) => s.username === "carol").map((s) => s.type);
  assert.deepEqual(stages, ["m.login.registration_token", "m.login.dummy"]);
});

test("inviteFriends skips users that do not exist yet with a clear message", async () => {
  const messages = [];
  const client = createMatrixClient(baseUrl);
  const summary = await seed(client, makeConfig([`@ghost:${SERVER_NAME}`]), (m) => messages.push(m));

  assert.equal(summary.invited, 0, "non-existent user is not invited");
  assert.ok(
    messages.some((m) => m.includes("skip invite for @ghost") && m.includes("does not exist")),
    "logs a clear skip message",
  );
});

test("toUserId accepts localpart, @localpart and full MXID", () => {
  assert.equal(toUserId("aub", "chat.example"), "@aub:chat.example");
  assert.equal(toUserId("@aub", "chat.example"), "@aub:chat.example");
  assert.equal(toUserId("@aub:chat.example", "other.example"), "@aub:chat.example");

  assert.equal(toLocalpart("@aub:chat.example"), "aub");
  assert.equal(toLocalpart("aub"), "aub");
});

test("resolveConfig derives server name, admin MXID and homeserver URL", () => {
  const cfg = resolveConfig({
    CHAT_FQDN: "chat.example",
    SQUADZ_ADMIN_PASSWORD: "pw",
    TUWUNEL_REGISTRATION_TOKEN: "tok",
  });
  assert.equal(cfg.serverName, "chat.example");
  assert.equal(cfg.adminUser, "admin");
  assert.equal(cfg.adminUserId, "@admin:chat.example");
  assert.equal(cfg.homeserverUrl, "https://chat.example");
  assert.equal(cfg.registrationToken, "tok");
});
