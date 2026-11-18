// Phase 5 (soundboard container running): send `!sb play beep in Lounge` in #clips and assert the
// bot joins the LiveKit room (LiveKit server API: ListParticipants) and its MatrixRTC membership.
import {
  CALL_MEMBER_EVENT_TYPE,
  buildCallMemberStateKey,
} from "../../bots/soundboard/src/matrixrtc.js";
import {
  assert,
  lkListParticipants,
  lkRoomName,
  loadConfig,
  loggedInClient,
  readState,
  run,
  sendText,
  step,
  waitFor,
} from "./lib.mjs";

run(async () => {
  const cfg = loadConfig();
  const state = readState();
  const clips = state.roomIds?.clips;
  const lounge = state.roomIds?.lounge;
  assert(clips && lounge && state.botUserId, "state.json has phase 2-4 output");

  const { client: admin } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);

  await step("bot is online and joined #clips and #lounge", async () => {
    for (const roomId of [clips, lounge]) {
      await waitFor(
        `bot membership in ${roomId}`,
        async () => (await admin.getMember(roomId, state.botUserId))?.membership === "join",
        { timeoutMs: 120_000, intervalMs: 2_000 },
      );
    }
    // The bot starts long-polling right after its first sync; give it a moment before commanding.
    await new Promise((r) => setTimeout(r, 5_000));
  });

  await step("`!sb play beep in Lounge` makes the bot join the LiveKit room", async () => {
    await sendText(admin, clips, "!sb play beep in Lounge");
    const lkRoom = lkRoomName(lounge);
    const participant = await waitFor(
      `bot participant in LiveKit room ${lkRoom}`,
      async () => (await lkListParticipants(cfg, lkRoom)).find((p) => p.identity.startsWith(state.botUserId)),
      { timeoutMs: 90_000, intervalMs: 2_000 },
    );
    process.stdout.write(
      `bot participant: ${JSON.stringify({ identity: participant.identity, state: participant.state, tracks: participant.tracks?.length ?? 0 })}\n`,
    );
  });

  await step("bot published its MatrixRTC call.member in #lounge", async () => {
    const st = await admin.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(lounge)}/state`);
    const mine = st.filter(
      (e) => e.type === CALL_MEMBER_EVENT_TYPE && e.sender === state.botUserId && e.content?.application === "m.call",
    );
    assert(mine.length === 1, `exactly one active bot call.member (state key ${buildCallMemberStateKey(state.botUserId, "SOUNDBOARD")})`);
  });
});
