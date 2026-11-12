// scripts/lib/seed.mjs
//
// Idempotent seeding of the Squadz Space, rooms, emoji pack and friend invites.
// Run repeatedly: the first run creates everything, subsequent runs create
// nothing (rooms are found by alias, the admin is found by login, the emoji
// pack is skipped when already present, and already-invited friends are left
// alone).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Seeded topology (matches docs/plans/P1-foundation.md § Contract)
//
//   Space "Squadz" (#squadz:CHAT_FQDN)
//     #general, #games, #clips, #memes   (text rooms)
//     #lounge, #game-night               (voice rooms, MatrixRTC call rooms)
//
// Room aliases are #<slug>:CHAT_FQDN.
// ---------------------------------------------------------------------------

export const SPACE = { slug: "squadz", name: "Squadz", space: true, voice: false, encrypted: false };

export const ROOMS = [
  { slug: "general", name: "General", voice: false, encrypted: true },
  { slug: "games", name: "Games", voice: false, encrypted: true },
  // #clips is where the soundboard bot (B3) listens. The bot speaks plain
  // `fetch` (no E2EE), so this room is deliberately left unencrypted.
  { slug: "clips", name: "Clips", voice: false, encrypted: false },
  { slug: "memes", name: "Memes", voice: false, encrypted: true },
  { slug: "lounge", name: "Lounge", voice: true, encrypted: true },
  { slug: "game-night", name: "Game Night", voice: true, encrypted: true },
];

const EMOJI_STATE_TYPE = "im.ponies.room_emotes"; // MSC2545 unstable identifier (what Element X implements)

// ---------------------------------------------------------------------------
// Voice-room / MatrixRTC setup
//
// Element X and Element Call treat a room as a call room when it has an OPEN
// MatrixRTC *slot*. We create that slot at room-creation time (as MSC4196
// recommends) rather than relying on an admin to add it later.
//
// Chosen identifiers (matching the current Element / matrix-js-sdk reference
// implementation, which both Element Call and Element X interoperate with):
//   - slot state event type:  org.matrix.msc4143.rtc.slot   (MSC4143 unstable)
//   - slot state_key:         m.call#ROOM                    (uppercase "ROOM",
//                             per the MSC4196 implementation note; the spec
//                             text says "room" but the reference impl uses
//                             "ROOM")
//   - application type:       m.call                          (MSC4196)
//   - encryption type:        org.matrix.msc4143.per_member   (MSC4143 unstable)
//
// The SFU transport itself is discovered by clients from the homeserver's
// `.well-known` org.matrix.msc4143.rtc_foci (served by Caddy per the contract),
// so bootstrap.mjs does not touch it.
// ---------------------------------------------------------------------------

/** Build the open MatrixRTC call-slot state event for a voice room. */
function rtcSlotEvent() {
  return {
    type: "org.matrix.msc4143.rtc.slot",
    state_key: "m.call#ROOM",
    content: {
      status: "open",
      application: { type: "m.call" },
      encryption: { type: "org.matrix.msc4143.per_member" },
    },
  };
}

/**
 * Full m.room.power_levels content. Admin holds 100; friends are default (0)
 * and can message, react, and hop in/out of calls. Voice rooms additionally
 * grant legacy `m.call.member` state events at 0 so older clients (pre-sticky
 * MatrixRTC) can also join.
 */
function powerLevels(adminUserId, voice) {
  const events = {
    "m.room.avatar": 50,
    "m.room.canonical_alias": 50,
    "m.room.encryption": 100,
    "m.room.history_visibility": 100,
    "m.room.name": 50,
    "m.room.power_levels": 100,
    "m.room.server_acl": 100,
    "m.room.tombstone": 100,
  };
  if (voice) {
    events["org.matrix.msc3401.call"] = 0;
    events["org.matrix.msc3401.call.member"] = 0;
  }
  return {
    ban: 50,
    events,
    events_default: 0,
    invite: 0,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: { [adminUserId]: 100 },
    users_default: 0,
  };
}

function buildCreateRoomBody(config, def) {
  const body = {
    name: def.name,
    room_alias_name: def.slug,
    preset: "private_chat",
    power_level_content_override: powerLevels(config.adminUserId, def.voice),
  };

  if (def.space) {
    body.creation_content = { type: "m.space" };
  }

  const initial_state = [];
  if (def.encrypted) {
    initial_state.push({
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }
  if (def.voice) {
    initial_state.push(rtcSlotEvent());
  }
  if (initial_state.length) body.initial_state = initial_state;

  return body;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PUT a state event only if it differs from (or is absent in) current state. */
async function setStateIfChanged(client, roomId, type, stateKey, content) {
  const current = await client.getState(roomId, type, stateKey);
  if (current && JSON.stringify(current) === JSON.stringify(content)) return false;
  await client.putState(roomId, type, stateKey, content);
  return true;
}

/** Read width/height from a PNG buffer's IHDR chunk (bytes 16..23). */
function pngDimensions(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { w: 0, h: 0 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Register the admin if missing, otherwise log in. */
async function ensureAdmin(client, config) {
  // Fast path: the admin already exists, so log in.
  try {
    const { user_id, access_token } = await client.login(config.adminUser, config.adminPassword);
    client.token = access_token;
    return { userId: user_id, registered: false };
  } catch (err) {
    if (!(err.errcode === "M_FORBIDDEN" || err.errcode === "M_UNKNOWN")) throw err;
  }

  // Admin missing: register using the token.
  try {
    const { user_id, access_token } = await client.register(
      config.adminUser,
      config.adminPassword,
      config.registrationToken,
    );
    client.token = access_token;
    return { userId: user_id, registered: true };
  } catch (err) {
    // Lost a race with another bootstrap run: the user now exists.
    if (err.errcode === "M_USER_IN_USE") {
      const { user_id, access_token } = await client.login(config.adminUser, config.adminPassword);
      client.token = access_token;
      return { userId: user_id, registered: false };
    }
    throw err;
  }
}

/** Ensure a room (or space) exists by alias, creating it if necessary. */
async function ensureRoom(client, config, def) {
  const alias = `#${def.slug}:${config.serverName}`;
  const existing = await client.resolveAlias(alias);
  if (existing) return existing;
  const { room_id } = await client.createRoom(buildCreateRoomBody(config, def));
  return room_id;
}

/** Link child rooms to the Space with m.space.child / m.space.parent. */
async function ensureSpaceLinks(client, config, spaceId, roomIds) {
  let changed = 0;
  const ordered = Object.keys(roomIds);
  for (let i = 0; i < ordered.length; i++) {
    const slug = ordered[i];
    const roomId = roomIds[slug];
    const child = { via: [config.serverName], suggested: true, order: String(i) };
    if (await setStateIfChanged(client, spaceId, "m.space.child", roomId, child)) changed++;
    const parent = { via: [config.serverName], canonical: true };
    if (await setStateIfChanged(client, roomId, "m.space.parent", spaceId, parent)) changed++;
  }
  return changed;
}

/** Create the emoji pack (MSC2545 im.ponies.room_emotes) on the Space. */
async function ensureEmojiPack(client, config, spaceId, emojiDir) {
  const current = await client.getState(spaceId, EMOJI_STATE_TYPE, "");
  if (current && Object.keys(current).length > 0) {
    return { uploaded: 0, set: false };
  }

  const files = readdirSync(emojiDir).filter((f) => f.toLowerCase().endsWith(".png")).sort();
  const content = {};
  let uploaded = 0;
  for (const file of files) {
    const shortcode = file.replace(/\.png$/i, "");
    const bytes = readFileSync(path.join(emojiDir, file));
    const { content_uri } = await client.upload(file, bytes, "image/png");
    uploaded++;
    const { w, h } = pngDimensions(bytes);
    content[shortcode] = {
      url: content_uri,
      body: shortcode,
      info: { w, h, size: bytes.length, mimetype: "image/png" },
    };
  }

  if (Object.keys(content).length > 0) {
    await client.putState(spaceId, EMOJI_STATE_TYPE, "", content);
    return { uploaded, set: true };
  }
  return { uploaded, set: false };
}

/** Invite each friend to the Space and every child room (skips existing members). */
async function inviteFriends(client, config, spaceId, roomIds) {
  const targets = [spaceId, ...Object.values(roomIds)];
  let invited = 0;
  for (const friend of config.invite ?? []) {
    const userId = friend.includes(":") ? friend : `@${friend}:${config.serverName}`;
    for (const roomId of targets) {
      const member = await client.getMember(roomId, userId);
      if (member && (member.membership === "join" || member.membership === "invite")) continue;
      await client.invite(roomId, userId);
      invited++;
    }
  }
  return invited;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Seed the homeserver. Idempotent.
 *
 * @param {ReturnType<typeof import("./matrix.mjs").createMatrixClient>} client
 * @param {object} config Resolved config (see config.mjs) plus `invite` (MXIDs)
 *   and `emojiDir` (absolute path to assets/emoji).
 * @param {(msg: string) => void} [log]
 * @returns {Promise<object>} Summary of what was created this run.
 */
export async function seed(client, config, log = () => {}) {
  const summary = {
    admin: null,
    spaceId: null,
    roomIds: {},
    createdRooms: 0,
    spaceLinksChanged: 0,
    emoji: { uploaded: 0, set: false },
    invited: 0,
  };

  summary.admin = await ensureAdmin(client, config);
  log(`admin: ${summary.admin.userId} (${summary.admin.registered ? "registered" : "existing"})`);

  // Space first, then child rooms.
  const spaceId = await ensureRoom(client, config, SPACE);
  summary.spaceId = spaceId;

  const roomIds = {};
  for (const room of ROOMS) {
    const existing = await client.resolveAlias(`#${room.slug}:${config.serverName}`);
    if (existing) {
      roomIds[room.slug] = existing;
    } else {
      const { room_id } = await client.createRoom(buildCreateRoomBody(config, room));
      roomIds[room.slug] = room_id;
      summary.createdRooms++;
    }
  }
  summary.roomIds = roomIds;
  log(`space: ${spaceId}`);
  for (const slug of Object.keys(roomIds)) log(`  ${slug}: ${roomIds[slug]}`);

  summary.spaceLinksChanged = await ensureSpaceLinks(client, config, spaceId, roomIds);
  summary.emoji = await ensureEmojiPack(client, config, spaceId, config.emojiDir);
  summary.invited = await inviteFriends(client, config, spaceId, roomIds);

  log(
    `emoji: ${summary.emoji.uploaded} uploaded, pack ${summary.emoji.set ? "set" : "already present"}; ` +
      `invited ${summary.invited} friend(s)`,
  );

  return summary;
}
