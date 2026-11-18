// Phase 3: second user -> OpenID token -> lk-jwt-service /sfu/get (room = voice room's roomId, as
// bots/soundboard does) -> LiveKit signalling join with the returned JWT.
import {
  assert,
  assertEq,
  decodeJwt,
  joinRoom,
  lkListParticipants,
  lkRoomName,
  lkSignalJoin,
  loadConfig,
  loggedInClient,
  readState,
  registerOrLogin,
  run,
  step,
  waitFor,
  writeState,
} from "./lib.mjs";

const ALICE = "e2e-alice";
const ALICE_PASSWORD = "e2e-alice-password-1";

run(async () => {
  const cfg = loadConfig();
  const state = readState();
  const lounge = state.roomIds?.lounge;
  assert(lounge, "state.json has the lounge room id (run phase 2 first)");

  const alice = await step("register second user with the test registration token", async () => {
    const a = await registerOrLogin(cfg, ALICE, ALICE_PASSWORD);
    assertEq(a.userId, `@${ALICE}:${cfg.chatFqdn}`, "alice user id");
    assert(a.deviceId, "alice has a device id");
    return a;
  });

  await step("admin invites alice to Space + #lounge + #clips; alice joins", async () => {
    const { client: admin } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
    for (const roomId of [state.spaceId, state.roomIds.lounge, state.roomIds.clips]) {
      try {
        await admin.invite(roomId, alice.userId);
      } catch (err) {
        if (!/already|cannot invite user that is joined/i.test(err.message)) throw err;
      }
      await joinRoom(alice.client, roomId);
    }
  });

  const sfu = await step("OpenID token -> POST /livekit/jwt/sfu/get returns {url, jwt}", async () => {
    const openid = await alice.client.request(
      "POST",
      `/_matrix/client/v3/user/${encodeURIComponent(alice.userId)}/openid/request_token`,
      { body: {} },
    );
    assert(openid.access_token, "openid access_token");
    assertEq(openid.matrix_server_name, cfg.chatFqdn, "openid matrix_server_name");

    const res = await fetch(`${cfg.rtcUrl}/livekit/jwt/sfu/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: lounge, openid_token: openid, device_id: alice.deviceId }),
    });
    const text = await res.text();
    assertEq(res.status, 200, `sfu/get status (body: ${text})`);
    const body = JSON.parse(text);
    assertEq(body.url, `wss://${cfg.rtcFqdn}/livekit/sfu`, "LiveKit URL returned");
    const claims = decodeJwt(body.jwt);
    assertEq(claims.iss, cfg.lkKey, "JWT issuer = LIVEKIT_API_KEY");
    assertEq(claims.video?.room, lkRoomName(lounge), "JWT room = hashed(roomId, m.call#ROOM)");
    assertEq(claims.video?.roomJoin, true, "JWT roomJoin grant");
    assertEq(claims.sub, `${alice.userId}:${alice.deviceId}`, "JWT identity");
    return { ...body, claims };
  });

  await step("LiveKit join with the JWT succeeds (signalling join + participant visible via server API)", async () => {
    const { ws, firstFrameBytes } = await lkSignalJoin(sfu.url.replace(/^wss/, "https"), sfu.jwt);
    try {
      assert(firstFrameBytes > 0, "server sent a join response frame");
      const found = await waitFor(
        "alice listed as a participant in the LiveKit room",
        async () => {
          const ps = await lkListParticipants(cfg, sfu.claims.video.room);
          return ps.find((p) => p.identity === sfu.claims.sub);
        },
        { timeoutMs: 20_000, intervalMs: 1_000 },
      );
      process.stdout.write(`participant: ${JSON.stringify({ identity: found.identity, state: found.state })}\n`);
    } finally {
      ws.close();
    }
  });

  writeState({
    alice: { userId: alice.userId, deviceId: alice.deviceId, password: ALICE_PASSWORD },
    loungeLkRoom: sfu.claims.video.room,
  });
});
