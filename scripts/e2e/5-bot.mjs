// Phase 5 (soundboard container running): send `!sb play beep in Lounge` in #clips and assert the
// bot joins the LiveKit room (LiveKit server API: ListParticipants) and its MatrixRTC membership.
import { sineWav } from "../../bots/soundboard/src/wav.js";
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
  // `!sb add`: upload a tiny wav as m.audio in #clips, reply to it with `!sb add e2etest`, then
  // check the bot's notices and that the new clip is listed (and playable) without a restart.
  const botNotices = async (needle) => {
    const res = await admin.request(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(clips)}/messages?dir=b&limit=30`,
    );
    return (res.chunk ?? []).filter(
      (e) => e.sender === state.botUserId && e.type === "m.room.message" && String(e.content?.body ?? "").includes(needle),
    );
  };

  await step("`!sb add e2etest` (reply to an uploaded m.audio) saves a clip", async () => {
    const wav = sineWav({ freq: 660, seconds: 0.3, rate: 8000 });
    const up = await admin.request("POST", "/_matrix/media/v3/upload?filename=e2etest.wav", {
      body: wav,
      contentType: "audio/wav",
    });
    assert(up.content_uri?.startsWith("mxc://"), "media upload returned an mxc uri");
    const audio = await admin.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(clips)}/send/m.room.message/e2e-audio-${Date.now()}`,
      {
        body: {
          msgtype: "m.audio",
          body: "e2etest.wav",
          url: up.content_uri,
          info: { mimetype: "audio/wav", size: wav.length, duration: 300 },
        },
      },
    );
    await admin.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(clips)}/send/m.room.message/e2e-add-${Date.now()}`,
      {
        body: {
          msgtype: "m.text",
          body: "!sb add e2etest",
          "m.relates_to": { "m.in_reply_to": { event_id: audio.event_id } },
        },
      },
    );
    await waitFor(
      "bot notice 'Saved clip \"e2etest\"'",
      async () => (await botNotices('Saved clip "e2etest"')).length > 0,
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
  });

  await step("`!sb list` contains the freshly added clip (no restart)", async () => {
    await sendText(admin, clips, "!sb list");
    await waitFor(
      "bot list notice containing e2etest",
      async () => (await botNotices("Available clips")).some((e) => e.content.body.includes("e2etest")),
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
  });
});
