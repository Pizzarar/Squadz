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
  const space = state.spaceId;
  const clips = state.roomIds?.clips;
  const lounge = state.roomIds?.lounge;
  assert(space && clips && lounge && state.botUserId, "state.json has phase 2-4 output");

  const { client: admin } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);

  await step("bot is online and joined the Space, #clips and #lounge", async () => {
    // The bot joins every invited room during its first sync, so once all three
    // memberships read "join" it has finished that sync and is long-polling (no
    // extra settle sleep is needed before commanding it).
    for (const roomId of [space, clips, lounge]) {
      await waitFor(
        `bot membership in ${roomId}`,
        async () => (await admin.getMember(roomId, state.botUserId))?.membership === "join",
        { timeoutMs: 120_000, intervalMs: 2_000 },
      );
    }
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
