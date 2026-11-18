// scripts/lib/emoji.mjs
//
// Discord-style custom emoji / stickers for the server owner (`squadz emoji`).
// Maintains the MSC2545 image pack (`im.ponies.room_emotes`, state_key "") on the
// Space and every text room: exactly the targets seed.mjs's ensureEmojiPack uses.
// Pure helpers (sniffing, validation, pack merge/remove) are unit-tested; the
// network part reuses the matrix.mjs client. No dependencies.

import { ROOMS, SPACE } from "./seed.mjs";

export const PACK_EVENT_TYPE = "im.ponies.room_emotes";
export const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;
export const MAX_BYTES = { emoticon: 256 * 1024, sticker: 512 * 1024 };

export function validateShortcode(code) {
  if (typeof code !== "string" || !SHORTCODE_RE.test(code)) {
    throw new Error(`invalid shortcode "${code}": use 2-32 characters of a-z, 0-9 and _`);
  }
  return code;
}

/**
 * Detect mimetype and pixel size from the file header. Supports png, gif, webp
 * (VP8 / VP8L / VP8X) and jpeg. Returns null if the type is unsupported or the
 * header is too short/corrupt to read dimensions from.
 * @param {Buffer} buf
 * @returns {{ mimetype: string, w: number, h: number } | null}
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // PNG: signature, then IHDR width/height at 16..23.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mimetype: "image/png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", logical screen size is two LE u16 at 6..9.
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF" && /^8[79]a$/.test(buf.toString("latin1", 3, 6))) {
    return { mimetype: "image/gif", w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const fourcc = buf.toString("latin1", 12, 16);
    if (fourcc === "VP8X") {
      return { mimetype: "image/webp", w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (fourcc === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { mimetype: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { mimetype: "image/webp", w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  // JPEG: walk the marker segments to the first SOFn frame header. Any truncation or
  // malformed length returns null, exactly like an unsupported header.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      // A marker may be padded with any number of 0xFF fill bytes.
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i >= buf.length) return null;                  // truncated inside fill bytes
      const marker = buf[i++];
      if (marker === 0x00) continue;                     // 0xFF00: stuffed byte in scan data, not a marker
      // Standalone markers carry no length field: SOI, TEM and RSTn.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      // Every other marker is followed by a u16 length that includes those two bytes.
      if (i + 2 > buf.length) return null;               // truncated length field
      const len = buf.readUInt16BE(i);
      if (len < 2) return null;                          // malformed: a segment cannot be shorter than its length field
      const end = i + len;
      if (end > buf.length) return null;                 // truncated segment
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (end < i + 7) return null;                    // segment too short to hold height/width
        return { mimetype: "image/jpeg", h: buf.readUInt16BE(i + 3), w: buf.readUInt16BE(i + 5) };
      }
      i = end;
    }
    return null;
  }
  return null;
}

/**
 * Validate an image file's bytes for use as an emoji or sticker.
 * @returns {{ mimetype: string, w: number, h: number, size: number }}
 */
export function validateImage(buf, usage) {
  const sniffed = sniffImage(buf);
  if (!sniffed) throw new Error("unsupported or unreadable image: must be png, gif, webp or jpg");
  if (!sniffed.w || !sniffed.h) throw new Error("image has zero width/height");
  const max = MAX_BYTES[usage];
  if (buf.length > max) {
    throw new Error(`${usage === "sticker" ? "sticker" : "emoji"} is ${(buf.length / 1024).toFixed(1)}KB; the limit is ${max / 1024}KB`);
  }
  return { ...sniffed, size: buf.length };
}

/** Add (or replace) an image in a pack, keeping everything else. Pure. */
export function mergeImage(pack, shortcode, image) {
  const base = pack && typeof pack === "object" ? pack : {};
  return {
    ...base,
    pack: base.pack ?? { display_name: "Squadz", usage: ["emoticon"] },
    images: { ...(base.images ?? {}), [shortcode]: image },
  };
}

/** Remove an image from a pack. Pure. Returns the pack unchanged if absent. */
export function removeImage(pack, shortcode) {
  if (!pack?.images || !(shortcode in pack.images)) return pack;
  const images = { ...pack.images };
  delete images[shortcode];
  return { ...pack, images };
}

export function buildImage({ url, shortcode, usage, meta }) {
  return {
    url,
    body: shortcode,
    info: { w: meta.w, h: meta.h, size: meta.size, mimetype: meta.mimetype },
    usage: [usage],
  };
}

/** Room ids of the pack targets: Space first, then every text room (seed.mjs topology). */
export async function packTargets(client, config) {
  const slugs = [SPACE.slug, ...ROOMS.filter((r) => !r.voice).map((r) => r.slug)];
  const targets = [];
  for (const slug of slugs) {
    const roomId = await client.resolveAlias(`#${slug}:${config.serverName}`);
    if (roomId) targets.push({ slug, roomId });
  }
  if (!targets.length || targets[0].slug !== SPACE.slug) {
    throw new Error("the Squadz Space was not found. Run: node scripts/bootstrap.mjs");
  }
  return targets;
}

/** Apply `fn(currentPack) -> newPack` to every target; PUT only when it changed. */
async function updatePacks(client, targets, fn) {
  const changed = [];
  for (const t of targets) {
    const current = await client.getState(t.roomId, PACK_EVENT_TYPE, "");
    const next = fn(current);
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    await client.putState(t.roomId, PACK_EVENT_TYPE, "", next);
    changed.push(t.slug);
  }
  return changed;
}

/**
 * Upload `bytes` and add it as `shortcode` in every pack. Re-running with the
 * same shortcode replaces that one image; all other images are kept.
 */
export async function addEmoji(client, config, { shortcode, bytes, filename, usage = "emoticon" }) {
  validateShortcode(shortcode);
  const meta = validateImage(bytes, usage);
  const targets = await packTargets(client, config);
  const { content_uri } = await client.upload(filename || shortcode, bytes, meta.mimetype);
  const image = buildImage({ url: content_uri, shortcode, usage, meta });
  const changed = await updatePacks(client, targets, (p) => mergeImage(p, shortcode, image));
  return { url: content_uri, usage, info: image.info, changed, targets: targets.length };
}

export async function removeEmoji(client, config, shortcode) {
  validateShortcode(shortcode);
  const targets = await packTargets(client, config);
  const changed = await updatePacks(client, targets, (p) => removeImage(p, shortcode));
  return { changed, targets: targets.length };
}

/** Read the pack from the Space. @returns {Array<{shortcode, usage, url, info}>} */
export async function listEmoji(client, config) {
  const [space] = await packTargets(client, config);
  const pack = await client.getState(space.roomId, PACK_EVENT_TYPE, "");
  const packUsage = pack?.pack?.usage ?? ["emoticon"];
  return Object.entries(pack?.images ?? {})
    .map(([shortcode, img]) => ({ shortcode, usage: img.usage ?? packUsage, url: img.url, info: img.info }))
    .sort((a, b) => a.shortcode.localeCompare(b.shortcode));
}
