// Phase 2b: `squadz emoji` against the live Tuwunel. Adds a tiny png emoji and a sticker via the
// real lib (same code the CLI calls), reads the pack back from a text room, then removes them.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addEmoji, listEmoji, removeEmoji } from "../lib/emoji.mjs";
import { assert, assertEq, loadConfig, loggedInClient, readState, run, step } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEEDED = ["emoji", "stickers"].flatMap((d) => readdirSync(path.resolve(here, "..", "..", "assets", d)).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4))).sort();

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

run(async () => {
  const cfg = loadConfig();
  const state = readState();
  assert(state.roomIds?.general, "state.json has room ids from phase 2");
  const { client } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
  const config = { serverName: cfg.chatFqdn };
  const read = () => client.getState(state.roomIds.general, "im.ponies.room_emotes", "");

  await step("emoji add: png emoji lands in the pack of a text room", async () => {
    const r = await addEmoji(client, config, { shortcode: "e2e_dot", bytes: PNG, filename: "e2e_dot.png" });
    assertEq(r.targets, 5, "Space + 4 text rooms");
    const pack = await read();
    const img = pack.images.e2e_dot;
    assert(img && String(img.url).startsWith("mxc://"), "e2e_dot has an mxc url");
    assertEq([img.info.w, img.info.h, img.info.size, img.info.mimetype], [1, 1, PNG.length, "image/png"], "info block");
    assertEq(img.usage, ["emoticon"], "emoticon usage");
    assertEq(SEEDED.every((k) => k in pack.images), true, "seeded images kept");
  });

  await step("emoji add --sticker + list + remove", async () => {
    await addEmoji(client, config, { shortcode: "e2e_stk", bytes: PNG, usage: "sticker" });
    assertEq((await read()).images.e2e_stk.usage, ["sticker"], "sticker usage");
    const list = await listEmoji(client, config);
    assertEq(list.map((i) => i.shortcode).includes("e2e_stk"), true, "listed");
    await removeEmoji(client, config, "e2e_dot");
    await removeEmoji(client, config, "e2e_stk");
    assertEq(Object.keys((await read()).images).sort(), SEEDED, "back to the seeded pack");
  });
});
