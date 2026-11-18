// Phase 2d (block D5): Tuwunel pushes with OUR config (federation off; the default ip_range_denylist
// is relaxed only in the CI overlay so the compose-network mock is reachable). Registers an HTTP
// pusher (event_id_only, like Element X) pointing at the push-mock container, has a second user
// send a message, and asserts the mock received POST /_matrix/push/v1/notify for that event.
import { assert, assertEq, loadConfig, loggedInClient, registerOrLogin, joinRoom, readState, run, sendText, step, waitFor } from "./lib.mjs";

const MOCK = process.env.PUSH_MOCK_URL ?? "http://127.0.0.1:8099";
const PUSHKEY = "e2e-pushkey-d5";

run(async () => {
  const cfg = loadConfig();
  const general = readState().roomIds?.general;
  assert(general, "state.json has the #general room id from phase 2");

  await step("federation is off (pushes must not depend on it)", async () => {
    const res = await fetch(`${cfg.chatUrl}/_matrix/federation/v1/version`);
    assert(!res.ok, `federation API must be disabled, got HTTP ${res.status}`);
  });

  const { client: admin } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
  const { client: bob } = await registerOrLogin(cfg, "pushbob", "ci-pushbob-password-1");
  await joinRoom(bob, general).catch(() => {});

  await step("register an event_id_only HTTP pusher (what Element X sends)", async () => {
    await admin.request("POST", "/_matrix/client/v3/pushers/set", {
      body: {
        kind: "http", app_id: "io.element.android.x.e2e", app_display_name: "Element X (e2e)",
        device_display_name: "e2e", pushkey: PUSHKEY, lang: "en", append: false,
        data: { url: "http://push-mock:8080/_matrix/push/v1/notify", format: "event_id_only" },
      },
    });
  });

  await step("a message from another user reaches the push gateway", async () => {
    const { event_id } = await sendText(bob, general, `push me ${Date.now()}`);
    const hit = await waitFor("push gateway to receive the notification", async () => {
      const list = await (await fetch(`${MOCK}/received`)).json();
      return list.find((b) => b.notification?.event_id === event_id);
    }, { timeoutMs: 45_000 });
    const n = hit.notification;
    assertEq(n.room_id, general, "room_id");
    assertEq(n.devices?.[0]?.pushkey, PUSHKEY, "pushkey");
    assertEq(n.devices?.[0]?.data?.format, "event_id_only", "format");
    assert(n.content === undefined && n.sender === undefined, "event_id_only must not leak content/sender");
  });
});
