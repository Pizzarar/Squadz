// scripts/test/emoji.test.mjs: `squadz emoji` helpers + flow against the mock homeserver.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockHomeserver } from "./mock-homeserver.mjs";
import { createMatrixClient } from "../lib/matrix.mjs";
import { seed } from "../lib/seed.mjs";
import {
  addEmoji, buildImage, listEmoji, mergeImage, removeEmoji, removeImage, sniffImage,
  validateImage, validateShortcode,
} from "../lib/emoji.mjs";

// --- tiny inline fixtures (headers only; enough for dimension sniffing) -----
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const gif = (w, h) => {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};
const webpHead = (fourcc) => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write(fourcc, 12, "latin1");
  return b;
};
const webpX = (w, h) => {
  const b = webpHead("VP8X");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const webpL = (w, h) => {
  const b = webpHead("VP8L");
  b[20] = 0x2f;
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
};
const webpLossy = (w, h) => {
  const b = webpHead("VP8 ");
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
};
const jpeg = (w, h) => Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0
]);

test("sniffImage: png/gif/webp(3 variants)/jpeg mimetype + dimensions", () => {
  assert.deepEqual(sniffImage(png(64, 32)), { mimetype: "image/png", w: 64, h: 32 });
  assert.deepEqual(sniffImage(gif(10, 20)), { mimetype: "image/gif", w: 10, h: 20 });
  assert.deepEqual(sniffImage(webpX(300, 200)), { mimetype: "image/webp", w: 300, h: 200 });
  assert.deepEqual(sniffImage(webpL(48, 40)), { mimetype: "image/webp", w: 48, h: 40 });
  assert.deepEqual(sniffImage(webpLossy(128, 96)), { mimetype: "image/webp", w: 128, h: 96 });
  assert.deepEqual(sniffImage(jpeg(640, 480)), { mimetype: "image/jpeg", w: 640, h: 480 });
});

test("sniffImage: rejects text, svg, truncated data", () => {
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.from("hello world, definitely not an image")), null);
  assert.equal(sniffImage(png(1, 1).subarray(0, 12)), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("sniffImage: jpeg marker walk handles truncated, bad-length and padded segments", () => {
  const full = jpeg(640, 480);
  // Truncated: SOI + the first APP0 length, but no segment body.
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), null, "truncated APP0 body");
  // Truncated SOF0: the length fits, but the frame header does not.
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00, 0x00, 0x00])), null, "SOF too short");
  // Truncated mid-file: cut before the SOF segment's declared end.
  assert.equal(sniffImage(full.subarray(0, 26)), null, "cut inside SOF0");
  // len = 0 / len = 1 are malformed and must not loop (or read past the buffer).
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0, 0, 0])), null, "len = 0");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0, 0, 0])), null, "len = 1");
  // 0xFF fill bytes before a marker are skipped.
  const padded = Buffer.concat([full.subarray(0, 20), Buffer.from([0xff, 0xff, 0xff]), full.subarray(20)]);
  assert.deepEqual(sniffImage(padded), { mimetype: "image/jpeg", w: 640, h: 480 }, "fill bytes");
  // Standalone markers (RSTn, TEM) before the frame header carry no length.
  const standalone = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0x01]), full.subarray(2)]);
  assert.deepEqual(sniffImage(standalone), { mimetype: "image/jpeg", w: 640, h: 480 }, "standalone markers");
});

test("validateShortcode: [a-z0-9_]{2,32}", () => {
  for (const ok of ["ab", "party_parrot", "x1", "a".repeat(32)]) assert.equal(validateShortcode(ok), ok);
  for (const bad of ["a", "A1", "has-dash", "sp ace", ":colon:", "a".repeat(33), "", "é1"]) {
    assert.throws(() => validateShortcode(bad), /invalid shortcode/, bad);
  }
});

test("validateImage: type + size limits (256KB emoji, 512KB sticker)", () => {
  const big = (n) => Buffer.concat([png(8, 8), Buffer.alloc(n - 33)]);
  assert.equal(validateImage(big(256 * 1024), "emoticon").size, 256 * 1024);
  assert.throws(() => validateImage(big(256 * 1024 + 1), "emoticon"), /limit is 256KB/);
  assert.equal(validateImage(big(512 * 1024), "sticker").mimetype, "image/png");
  assert.throws(() => validateImage(big(512 * 1024 + 1), "sticker"), /limit is 512KB/);
  assert.throws(() => validateImage(Buffer.from("nope"), "emoticon"), /png, gif, webp or jpg/);
  assert.throws(() => validateImage(png(0, 0), "emoticon"), /zero width/);
});

test("mergeImage/removeImage: keep existing images, replace same shortcode, pure", () => {
  const meta = { w: 8, h: 8, size: 33, mimetype: "image/png" };
  const a = buildImage({ url: "mxc://s/a", shortcode: "a1", usage: "emoticon", meta });
  const b = buildImage({ url: "mxc://s/b", shortcode: "b1", usage: "sticker", meta });
  assert.deepEqual(b.usage, ["sticker"]);
  assert.deepEqual(b.info, meta);

  const empty = mergeImage(null, "a1", a);
  assert.deepEqual(empty.pack, { display_name: "Squadz", usage: ["emoticon"] });
  const orig = { pack: { display_name: "Custom", usage: ["emoticon"] }, images: { a1: a }, extra: 1 };
  const frozen = structuredClone(orig);
  const merged = mergeImage(orig, "b1", b);
  assert.deepEqual(orig, frozen, "input not mutated");
  assert.deepEqual(Object.keys(merged.images).sort(), ["a1", "b1"]);
  assert.equal(merged.pack.display_name, "Custom");
  assert.equal(merged.extra, 1);
  const a2 = { ...a, url: "mxc://s/a2" };
  assert.equal(mergeImage(merged, "a1", a2).images.a1.url, "mxc://s/a2");

  const removed = removeImage(merged, "a1");
  assert.deepEqual(Object.keys(removed.images), ["b1"]);
  assert.equal(removeImage(removed, "a1"), removed, "absent shortcode: unchanged");
  assert.equal(removeImage(null, "a1"), null);
});

// --- against the mock homeserver ---------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = "chat.squadz.test";
const mock = createMockHomeserver({ serverName: SERVER, registrationToken: "t" });
let client;
let config;
const packOf = (alias) => mock.state.rooms.get(mock.state.aliases.get(alias)).state.get("im.ponies.room_emotes\u0000");

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

test("addEmoji: sets pack in Space + 4 text rooms (not voice), keeps seeded images", async () => {
  const r = await addEmoji(client, config, { shortcode: "pixel", bytes: png(16, 16), filename: "pixel.png" });
  assert.equal(r.targets, 5);
  assert.equal(r.changed.length, 5);
  for (const slug of ["squadz", "general", "games", "clips", "memes"]) {
    const pack = packOf(`#${slug}:${SERVER}`);
    assert.deepEqual(Object.keys(pack.images).sort(), ["gg", "party", "pixel", "squadz", "wave"], slug);
    assert.deepEqual(pack.images.pixel.usage, ["emoticon"]);
    assert.deepEqual(pack.images.pixel.info, { w: 16, h: 16, size: 33, mimetype: "image/png" });
    assert.match(pack.images.pixel.url, /^mxc:\/\//);
  }
  for (const slug of ["lounge", "game-night"]) assert.equal(packOf(`#${slug}:${SERVER}`), undefined);
});

test("addEmoji --sticker, re-add replaces, others kept; list + remove", async () => {
  await addEmoji(client, config, { shortcode: "big", bytes: gif(100, 100), filename: "big.gif", usage: "sticker" });
  const first = packOf(`#general:${SERVER}`).images.big.url;
  assert.deepEqual(packOf(`#general:${SERVER}`).images.big.usage, ["sticker"]);
  await addEmoji(client, config, { shortcode: "big", bytes: gif(100, 100), filename: "big.gif", usage: "sticker" });
  const pack = packOf(`#general:${SERVER}`);
  assert.notEqual(pack.images.big.url, first);
  assert.equal(Object.keys(pack.images).length, 6);

  const list = await listEmoji(client, config);
  assert.deepEqual(list.map((i) => i.shortcode), ["big", "gg", "party", "pixel", "squadz", "wave"]);
  assert.deepEqual(list.find((i) => i.shortcode === "big").usage, ["sticker"]);
  assert.deepEqual(list.find((i) => i.shortcode === "wave").usage, ["emoticon"], "seeded image falls back to pack usage");

  const rm = await removeEmoji(client, config, "big");
  assert.equal(rm.changed.length, 5);
  assert.equal(packOf(`#memes:${SERVER}`).images.big, undefined);
  assert.equal((await removeEmoji(client, config, "big")).changed.length, 0, "second remove is a no-op");
});

test("addEmoji rejects bad input before touching the server", async () => {
  const uploads = mock.state.counts.upload;
  await assert.rejects(addEmoji(client, config, { shortcode: "Bad-Code", bytes: png(8, 8) }), /invalid shortcode/);
  await assert.rejects(addEmoji(client, config, { shortcode: "text", bytes: Buffer.from("not an image") }), /png, gif, webp or jpg/);
  await assert.rejects(addEmoji(client, config, { shortcode: "huge", bytes: Buffer.concat([png(8, 8), Buffer.alloc(300 * 1024)]) }), /256KB/);
  assert.equal(mock.state.counts.upload, uploads);
});
