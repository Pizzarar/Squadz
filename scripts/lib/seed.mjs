// scripts/lib/seed.mjs
//
// Idempotent seeding of the Squadz Space, rooms, seed art (emoji/sticker pack,
// Space + room avatars) and friend invites.
// Run repeatedly: the first run creates everything, subsequent runs create
// nothing (rooms are found by alias, the admin is found by login, seed art is
// only uploaded when missing or when bootstrap's own earlier art changed, and
// already-invited friends are left alone).

import crypto from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  // `fetch` (no E2EE), so this room is deliberately left unencrypted. The bot
  // also joins calls here, so members get call-membership power (calls: true)
  // even though it is not a dedicated voice room (no pre-opened call slot).
  { slug: "clips", name: "Clips", voice: false, encrypted: false, calls: true },
  { slug: "memes", name: "Memes", voice: false, encrypted: true },
  { slug: "lounge", name: "Lounge", voice: true, encrypted: true },
  { slug: "game-night", name: "Game Night", voice: true, encrypted: true },
];

// MSC2545 ("Image Packs") room state event type. `im.ponies.room_emotes` is the
// unstable identifier (Element X / Element desktop read this today); the stable
// `m.room.image_pack` is not widely deployed yet. Content is
// `{ pack: { display_name, usage }, images: { <shortcode>: { url, body, info, usage } } }`.
// The type constant and pack helpers live in emoji.mjs (D1 `squadz emoji`), reused below.

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
 * and can message, react, and hop in/out of calls. Rooms where calls happen
 * (dedicated voice rooms and `#clips`, where the soundboard bot joins) grant
 * every call-membership event type at 0 so any member can join/leave calls:
 *   - legacy MSC3401 group-call signalling (`org.matrix.msc3401.call`,
 *     `org.matrix.msc3401.call.member`) for older clients;
 *   - MatrixRTC membership (`org.matrix.msc4143.rtc.member`, unstable — what
 *     current Element Call / Element X send — and `m.rtc.member`, stable).
 */
function powerLevels(adminUserId, calls) {
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
  if (calls) {
    events["org.matrix.msc3401.call"] = 0;
    events["org.matrix.msc3401.call.member"] = 0;
    events["org.matrix.msc4143.rtc.member"] = 0;
    events["m.rtc.member"] = 0;
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

function buildCreateRoomBody(config, def, spaceId) {
  const body = {
    name: def.name,
    room_alias_name: def.slug,
    preset: "private_chat",
    power_level_content_override: powerLevels(config.adminUserId, def.voice || def.calls),
  };

  const initial_state = [];

  if (def.space) {
    body.creation_content = { type: "m.space" };
  } else if (spaceId) {
    // Restricted join rules (MSC3083, in the spec): anyone who is a member of
    // the Space may join the room without a separate invite. The admin still
    // creates and is a member of every room, so seeding is unaffected.
    initial_state.push({
      type: "m.room.join_rules",
      state_key: "",
      content: {
        join_rule: "restricted",
        allow: [{ type: "m.room_membership", room_id: spaceId }],
      },
    });
  }

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
  if (current && isDeepStrictEqual(current, content)) return false;
  await client.putState(roomId, type, stateKey, content);
  return true;
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
async function ensureRoom(client, config, def, spaceId) {
  const alias = `#${def.slug}:${config.serverName}`;
  const existing = await client.resolveAlias(alias);
  if (existing) return existing;
  const { room_id } = await client.createRoom(buildCreateRoomBody(config, def, spaceId));
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

// Seed-art bookkeeping on the Space: which images/avatars bootstrap itself put there, so a
// re-run can ship updated art without ever clobbering what the host changed via `squadz
// emoji` / `squadz server set`. Content: { images: {code: {url, sha256}}, avatars: {slug: {url, sha256}} }.
export const SEED_ART_STATE_TYPE = "dev.squadz.seed_art";

// Byte sizes of the pre-E3 placeholder emoji (32px squares). Packs seeded before
// seed-art tracking existed have no record; these mark images bootstrap may upgrade.
const LEGACY_PLACEHOLDER_SIZES = { gg: 465, party: 481, squadz: 489, wave: 468 };

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** PNGs in `dir` as [{ name, file, bytes, sha256 }], sorted; [] when the dir is missing. */
function readPngs(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .sort()
    .map((file) => {
      const bytes = readFileSync(path.join(dir, file));
      return { name: file.replace(/\.png$/i, ""), file, bytes, sha256: sha256(bytes) };
    });
}

/**
 * May bootstrap (re)write a seeded slot? `currentUrl` is what is there now (or null),
 * `mine` is bootstrap's own record { url, sha256 } (or undefined).
 *   empty and never seeded            -> write
 *   ours (or a legacy placeholder) and the art changed -> write
 *   the host's own image, the host removed ours, or ours and unchanged -> leave alone
 */
export function mayWrite(currentUrl, mine, sha, legacy = false) {
  if (!currentUrl) return !mine;
  const ours = mine ? currentUrl === mine.url : legacy;
  return ours && mine?.sha256 !== sha;
}

/**
 * Emoji + sticker pack (MSC2545 im.ponies.room_emotes) on the Space and every text room,
 * through the D1 `squadz emoji` helpers (validation, image entries, pack merge, targets).
 * assets/emoji/*.png are emoticons, assets/stickers/*.png are stickers; the file name is the
 * shortcode. Each file is uploaded once and the same MXC URL is referenced in every room.
 * Setting the pack per text room (not just on the Space) puts it in every member's picker.
 */
async function ensureEmojiPack(client, config, spaceId, rec) {
  const { PACK_EVENT_TYPE, validateShortcode, validateImage, buildImage, mergeImage, packTargets } =
    await import("./emoji.mjs");
  const stickerDir = config.stickerDir ?? path.join(config.emojiDir, "..", "stickers");
  const items = [
    ...readPngs(config.emojiDir).map((f) => ({ ...f, usage: "emoticon" })),
    ...readPngs(stickerDir).map((f) => ({ ...f, usage: "sticker" })),
  ];

  const pack = await client.getState(spaceId, PACK_EVENT_TYPE, "");
  const fresh = {};
  for (const item of items) {
    const code = validateShortcode(item.name);
    const current = pack?.images?.[code];
    const legacy = !rec.images?.[code] && current?.info?.size === LEGACY_PLACEHOLDER_SIZES[code];
    if (!mayWrite(current?.url, rec.images?.[code], item.sha256, legacy)) continue;
    const meta = validateImage(item.bytes, item.usage);
    const { content_uri } = await client.upload(item.file, item.bytes, meta.mimetype);
    fresh[code] = buildImage({ url: content_uri, shortcode: code, usage: item.usage, meta });
    rec.images = { ...rec.images, [code]: { url: content_uri, sha256: item.sha256 } };
  }

  const uploaded = Object.keys(fresh).length;
  if (uploaded === 0) return { uploaded: 0, set: 0 };

  let set = 0;
  for (const { roomId } of await packTargets(client, config)) {
    let next = await client.getState(roomId, PACK_EVENT_TYPE, "");
    for (const [code, image] of Object.entries(fresh)) next = mergeImage(next, code, image);
    if (await setStateIfChanged(client, roomId, PACK_EVENT_TYPE, "", next)) set++;
  }
  return { uploaded, set };
}

/**
 * Space icon (through the D3 `squadz server set --icon` helper) and per-room avatars from
 * assets/avatars/<slug>.png. Never replaces an avatar the host set (or cleared) themselves.
 */
async function ensureAvatars(client, config, spaceId, roomIds, rec) {
  const { setServer } = await import("./server.mjs");
  const { sniffImage } = await import("./emoji.mjs");
  const avatarDir = config.avatarDir ?? path.join(config.emojiDir, "..", "avatars");
  const files = Object.fromEntries(readPngs(avatarDir).map((f) => [f.name, f]));
  const ids = { [SPACE.slug]: spaceId, ...roomIds };
  const out = { uploaded: 0, set: 0 };

  for (const slug of [SPACE.slug, ...ROOMS.map((r) => r.slug)]) {
    const file = files[slug];
    const roomId = ids[slug];
    if (!file || !roomId) continue;
    const current = (await client.getState(roomId, "m.room.avatar", ""))?.url ?? null;
    if (!mayWrite(current, rec.avatars?.[slug], file.sha256)) continue;

    let url;
    if (slug === SPACE.slug) {
      const r = await setServer(client, config, { icon: { bytes: file.bytes, filename: file.file } });
      url = (await client.getState(roomId, "m.room.avatar", ""))?.url;
      if (r.changed.includes("icon")) out.set++;
    } else {
      const meta = sniffImage(file.bytes);
      url = (await client.upload(file.file, file.bytes, meta.mimetype)).content_uri;
      const info = { w: meta.w, h: meta.h, size: file.bytes.length, mimetype: meta.mimetype };
      if (await setStateIfChanged(client, roomId, "m.room.avatar", "", { url, info })) out.set++;
    }
    out.uploaded++;
    rec.avatars = { ...rec.avatars, [slug]: { url, sha256: file.sha256 } };
  }
  return out;
}

/**
 * Invite each friend to the Space. Child rooms use restricted join rules that
 * admit any Space member, so a friend who joins the Space can enter every room
 * without separate invites. Users that do not exist on the server yet are
 * skipped with a message rather than failing the run.
 */
async function inviteFriends(client, config, spaceId, log) {
  let invited = 0;
  for (const friend of config.invite ?? []) {
    const userId = friend.includes(":") ? friend : `@${friend}:${config.serverName}`;
    const member = await client.getMember(spaceId, userId);
    if (member && (member.membership === "join" || member.membership === "invite")) continue;
    try {
      await client.invite(spaceId, userId);
      invited++;
    } catch (err) {
      if (err.errcode === "M_NOT_FOUND" || err.status === 404) {
        log(`skip invite for ${userId}: user does not exist yet (they must register first)`);
        continue;
      }
      throw err;
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
 *   and `emojiDir` (absolute path to assets/emoji). Stickers and avatars default to the
 *   sibling assets/stickers and assets/avatars (override: `stickerDir`, `avatarDir`).
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
    emoji: { uploaded: 0, set: 0 },
    avatars: { uploaded: 0, set: 0 },
    invited: 0,
  };

  summary.admin = await ensureAdmin(client, config);
  log(`admin: ${summary.admin.userId} (${summary.admin.registered ? "registered" : "existing"})`);

  // Space first, then child rooms.
  const spaceId = await ensureRoom(client, config, SPACE, null);
  summary.spaceId = spaceId;

  const roomIds = {};
  for (const room of ROOMS) {
    const existing = await client.resolveAlias(`#${room.slug}:${config.serverName}`);
    if (existing) {
      roomIds[room.slug] = existing;
    } else {
      const { room_id } = await client.createRoom(buildCreateRoomBody(config, room, spaceId));
      roomIds[room.slug] = room_id;
      summary.createdRooms++;
    }
  }
  summary.roomIds = roomIds;
  log(`space: ${spaceId}`);
  for (const slug of Object.keys(roomIds)) log(`  ${slug}: ${roomIds[slug]}`);

  summary.spaceLinksChanged = await ensureSpaceLinks(client, config, spaceId, roomIds);
  // Tuwunel auto_join_rooms only joins public rooms (config/tuwunel.toml). The
  // Space is public so new registrants land in it; registration itself is
  // token-gated and federation is off. Child rooms stay restricted-to-Space.
  summary.spacePublic = await setStateIfChanged(client, spaceId, "m.room.join_rules", "", {
    join_rule: "public",
  });
  // Seed art: emoji/sticker pack and avatars, tracked in SEED_ART_STATE_TYPE on the Space.
  const art = { ...((await client.getState(spaceId, SEED_ART_STATE_TYPE, "")) ?? {}) };
  summary.emoji = await ensureEmojiPack(client, config, spaceId, art);
  summary.avatars = await ensureAvatars(client, config, spaceId, roomIds, art);
  await setStateIfChanged(client, spaceId, SEED_ART_STATE_TYPE, "", art);
  summary.invited = await inviteFriends(client, config, spaceId, log);

  log(
    `emoji/stickers: ${summary.emoji.uploaded} uploaded, pack set in ${summary.emoji.set} room(s); ` +
      `avatars: ${summary.avatars.set} set; ` +
      `invited ${summary.invited} friend(s)`,
  );

  return summary;
}
