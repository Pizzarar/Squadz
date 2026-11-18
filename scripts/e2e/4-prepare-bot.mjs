// Phase 4 (before starting the soundboard container): register the bot account, invite it to the
// Space + #clips + #lounge (it auto-joins invites on its first sync), and have alice put an active
// MatrixRTC membership into #lounge so `!sb play beep in Lounge` finds an active call.
import {
  buildCallMemberContent,
  buildCallMemberStateKey,
  CALL_MEMBER_EVENT_TYPE,
} from "../../bots/soundboard/src/matrixrtc.js";
import {
  assert,
  assertEq,
  loadConfig,
  loggedInClient,
  readState,
  registerOrLogin,
  run,
  step,
  writeState,
} from "./lib.mjs";

run(async () => {
  const cfg = loadConfig();
  const state = readState();
  assert(state.alice && state.roomIds, "state.json has phase 2+3 output");

  const bot = await step("register soundboard bot account", async () => {
    const b = await registerOrLogin(cfg, cfg.botUser, cfg.botPassword);
    assertEq(b.userId, `@${cfg.botUser}:${cfg.chatFqdn}`, "bot user id");
    return b;
  });

  await step("admin invites the bot to Space, #clips, #lounge", async () => {
    const { client: admin } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
    for (const roomId of [state.spaceId, state.roomIds.clips, state.roomIds.lounge]) {
      try {
        await admin.invite(roomId, bot.userId);
      } catch (err) {
        if (!/already|cannot invite user that is joined/i.test(err.message)) throw err;
      }
    }
  });

  await step("alice joins the #lounge call (call.member state event)", async () => {
    const { client, userId, deviceId } = await loggedInClient(cfg, "e2e-alice", state.alice.password);
    const content = buildCallMemberContent({
      deviceId,
      roomId: state.roomIds.lounge,
      livekitServiceUrl: `${cfg.rtcUrl}/livekit/jwt`,
    });
    await client.putState(state.roomIds.lounge, CALL_MEMBER_EVENT_TYPE, buildCallMemberStateKey(userId, deviceId), content);
    const back = await client.getState(state.roomIds.lounge, CALL_MEMBER_EVENT_TYPE, buildCallMemberStateKey(userId, deviceId));
    assertEq(back?.application, "m.call", "call.member stored");
  });

  writeState({ botUserId: bot.userId });
});
