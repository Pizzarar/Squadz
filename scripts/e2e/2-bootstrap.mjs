// Phase 2: run the real scripts/bootstrap.mjs against the live Tuwunel (through Caddy TLS), twice.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROOMS, SPACE } from "../lib/seed.mjs";
import {
  assert,
  assertEq,
  loadConfig,
  loggedInClient,
  parseBootstrapSummary,
  run,
  step,
  writeState,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bootstrap = path.resolve(here, "..", "bootstrap.mjs");

function runBootstrap(label) {
  const r = spawnSync(process.execPath, [bootstrap], { env: process.env, encoding: "utf8" });
  process.stdout.write(`--- bootstrap ${label} stdout:\n${r.stdout}\n`);
  if (r.stderr) process.stdout.write(`--- bootstrap ${label} stderr:\n${r.stderr}\n`);
  assertEq(r.status, 0, `bootstrap ${label} exit code`);
  return parseBootstrapSummary(r.stdout);
}

run(async () => {
  const cfg = loadConfig();
  const sn = cfg.chatFqdn;

  const first = await step("bootstrap run #1 creates the topology", async () => {
    const s = runBootstrap("#1");
    assert(s.spaceId?.startsWith("!"), "space id returned");
    assertEq(s.createdRooms, ROOMS.length, "createdRooms");
    assertEq(Object.keys(s.roomIds).sort(), ROOMS.map((r) => r.slug).sort(), "room slugs");
    assertEq(s.emoji.uploaded, 4, "emoji uploaded (assets/emoji/*.png)");
    return s;
  });

  await step("topology: Space, rooms, aliases, power levels, RTC slots", async () => {
    const { client, userId } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
    const adminId = userId;

    const spaceAlias = await client.resolveAlias(`#${SPACE.slug}:${sn}`);
    assertEq(spaceAlias, first.spaceId, "Space alias resolves to the Space");
    const create = await client.getState(first.spaceId, "m.room.create", "");
    assertEq(create?.type, "m.space", "Space room type");

    for (const def of ROOMS) {
      const roomId = first.roomIds[def.slug];
      assertEq(await client.resolveAlias(`#${def.slug}:${sn}`), roomId, `alias #${def.slug}`);

      const pl = await client.getState(roomId, "m.room.power_levels", "");
      assertEq(pl?.users?.[adminId], 100, `#${def.slug} admin power level`);
      assertEq(pl?.users_default, 0, `#${def.slug} users_default`);
      assertEq(pl?.state_default, 50, `#${def.slug} state_default`);
      if (def.voice || def.calls) {
        assertEq(pl?.events?.["org.matrix.msc3401.call.member"], 0, `#${def.slug} call.member power level`);
        assertEq(pl?.events?.["org.matrix.msc4143.rtc.member"], 0, `#${def.slug} rtc.member power level`);
      }

      const enc = await client.getState(roomId, "m.room.encryption", "");
      assertEq(Boolean(enc), Boolean(def.encrypted), `#${def.slug} encryption state`);

      const slot = await client.getState(roomId, "org.matrix.msc4143.rtc.slot", "m.call#ROOM");
      if (def.voice) assertEq(slot?.status, "open", `#${def.slug} RTC slot status`);
      else assertEq(slot, null, `#${def.slug} has no RTC slot`);
    }
  });

  await step("emote packs (im.ponies.room_emotes) on Space + text rooms", async () => {
    const { client } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
    const targets = [first.spaceId, ...["general", "games", "clips", "memes"].map((s) => first.roomIds[s])];
    for (const roomId of targets) {
      const pack = await client.getState(roomId, "im.ponies.room_emotes", "");
      assert(pack && pack.images, `emote pack present in ${roomId}`);
      assertEq(Object.keys(pack.images).sort(), ["gg", "party", "squadz", "wave"], `emote shortcodes in ${roomId}`);
      for (const img of Object.values(pack.images)) assert(String(img.url).startsWith("mxc://"), "emote url is mxc://");
    }
  });

  await step("space links: m.space.child on Space, m.space.parent on rooms", async () => {
    const { client } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
    for (const def of ROOMS) {
      const roomId = first.roomIds[def.slug];
      const child = await client.getState(first.spaceId, "m.space.child", roomId);
      assertEq(child?.via, [sn], `Space child via for #${def.slug}`);
      const parent = await client.getState(roomId, "m.space.parent", first.spaceId);
      assertEq(parent?.canonical, true, `#${def.slug} canonical parent`);
    }
  });

  await step("bootstrap run #2 is idempotent", async () => {
    const second = runBootstrap("#2");
    assertEq(second.spaceId, first.spaceId, "same Space id");
    assertEq(second.roomIds, first.roomIds, "same room ids");
    assertEq(second.createdRooms, 0, "createdRooms on re-run");
    assertEq(second.spaceLinksChanged, 0, "spaceLinksChanged on re-run");
    assertEq(second.emoji, { uploaded: 0, set: 0 }, "emoji on re-run");
    assertEq(second.invited, 0, "invited on re-run");
    assertEq(second.admin.registered, false, "admin already exists on re-run");
  });

  writeState({ spaceId: first.spaceId, roomIds: first.roomIds });
});
