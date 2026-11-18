// Phase 2c: `squadz server set|show` against the live Tuwunel. Sets the Space name and a topic,
// posts + pins a welcome (replacing the one bootstrap seeded), reads everything back.
import { setServer, showServer } from "../lib/server.mjs";
import { assert, assertEq, loadConfig, loggedInClient, readState, run, step } from "./lib.mjs";

run(async () => {
  const cfg = loadConfig();
  const state = readState();
  assert(state.roomIds?.general, "state.json has room ids from phase 2");
  const { client } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
  const config = { serverName: cfg.chatFqdn };
  const general = state.roomIds.general;
  const pins = async () => (await client.getState(general, "m.room.pinned_events", ""))?.pinned ?? [];

  await step("bootstrap seeded a pinned welcome (config/welcome.md)", async () => {
    const s = await showServer(client, config);
    assert(s.welcomeEventId, "welcome event is pinned after bootstrap");
    assertEq((await pins()).includes(s.welcomeEventId), true, "pinned_events contains it");
  });

  await step("server set: name + topic, idempotent on re-run", async () => {
    const opts = { name: "Squadz E2E", topics: [{ slug: "general", text: "e2e topic" }] };
    assertEq((await setServer(client, config, opts)).changed, ["name", "topic:general"], "first run changes both");
    assertEq((await setServer(client, config, opts)).changed, [], "second run is a no-op");
    const s = await showServer(client, config);
    assertEq(s.name, "Squadz E2E", "name read back");
    assertEq(s.topics.general, "e2e topic", "topic read back");
  });

  await step("server set --welcome: posts m.notice with formatted_body, replaces the pin", async () => {
    const before = await showServer(client, config);
    const r = await setServer(client, config, { welcome: "# E2E welcome\n\n- **bold** item" });
    assertEq(r.welcome.posted, true, "posted");
    const p = await pins();
    assertEq(p.includes(r.welcome.eventId), true, "new welcome pinned");
    assertEq(p.includes(before.welcomeEventId), false, "old welcome unpinned, not stacked");
    const msgs = await client.messages(general, 10);
    const ev = msgs.chunk.find((e) => e.event_id === r.welcome.eventId);
    assert(ev, "welcome event is in the timeline");
    assertEq(ev.content.msgtype, "m.notice", "msgtype");
    assertEq(ev.content.formatted_body, "<h1>E2E welcome</h1><ul><li><strong>bold</strong> item</li></ul>", "formatted_body");
    const again = await setServer(client, config, { welcome: "# E2E welcome\n\n- **bold** item" });
    assertEq(again.welcome.posted, false, "same text is not re-posted");
    assertEq((await showServer(client, config)).welcomeEventId, r.welcome.eventId, "show reports the pinned id");
  });
});
