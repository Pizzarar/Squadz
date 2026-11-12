import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_MEMBER_EVENT_TYPE,
  buildCallMemberStateKey,
  buildCallMemberContent,
  buildLeaveCallMemberContent,
  findActiveCallMemberships,
  hasActiveCall,
  fetchLiveKitJwt,
} from '../src/matrixrtc.js';
import { MatrixClient } from '../src/matrix.js';

describe('MatrixRTC call.member protocol helpers', () => {
  it('builds the MSC4143 per-device state_key (_userId_deviceId_m.call)', () => {
    const key = buildCallMemberStateKey('@soundboard:chat.squadz.test', 'SBDEV01');
    assert.equal(key, '_@soundboard:chat.squadz.test_SBDEV01_m.call');
  });

  it('builds valid MSC4143 / MSC3401 org.matrix.msc3401.call.member content and empty leave payload', () => {
    const content = buildCallMemberContent({
      deviceId: 'SBDEV01',
      roomId: '!lounge:chat.squadz.test',
      livekitServiceUrl: 'https://rtc.squadz.test/livekit/jwt',
      createdTs: 1700000000000,
    });

    assert.equal(content.application, 'm.call');
    assert.equal(content.call_id, '');
    assert.equal(content.scope, 'm.room');
    assert.equal(content.device_id, 'SBDEV01');
    assert.equal(content.created_ts, 1700000000000);
    assert.equal(typeof content.expires, 'number');
    assert.deepEqual(content.focus_active, {
      type: 'livekit',
      focus_selection: 'oldest_membership',
    });
    assert.deepEqual(content.foci_preferred, [
      {
        type: 'livekit',
        livekit_service_url: 'https://rtc.squadz.test/livekit/jwt',
        livekit_alias: '!lounge:chat.squadz.test',
      },
    ]);

    assert.deepEqual(buildLeaveCallMemberContent(), {});
  });

  it('detects active calls from both modern MSC4143 and legacy MSC3401 memberships while ignoring expired or bot entries', () => {
    const now = 1700000010000;
    const stateEvents = [
      // Left participant (empty content)
      {
        type: CALL_MEMBER_EVENT_TYPE,
        sender: '@ghost:chat.squadz.test',
        state_key: '_@ghost:chat.squadz.test_DEV0_m.call',
        content: {},
      },
      // Expired participant
      {
        type: CALL_MEMBER_EVENT_TYPE,
        sender: '@stale:chat.squadz.test',
        state_key: '_@stale:chat.squadz.test_DEV1_m.call',
        content: {
          application: 'm.call',
          device_id: 'DEV1',
          created_ts: now - 20000,
          expires: 5000,
        },
      },
      // Modern MSC4143 active participant
      {
        type: CALL_MEMBER_EVENT_TYPE,
        sender: '@alice:chat.squadz.test',
        state_key: '_@alice:chat.squadz.test_ALICEDEV_m.call',
        content: {
          application: 'm.call',
          call_id: '',
          scope: 'm.room',
          device_id: 'ALICEDEV',
          created_ts: now - 5000,
          expires: 3600000,
          foci_preferred: [
            {
              type: 'livekit',
              livekit_service_url: 'https://rtc.squadz.test/livekit/jwt',
              livekit_alias: '!lounge:chat.squadz.test',
            },
          ],
        },
      },
      // Legacy MSC3401 active participant (older timestamp -> should sort first)
      {
        type: CALL_MEMBER_EVENT_TYPE,
        sender: '@bob:chat.squadz.test',
        state_key: '@bob:chat.squadz.test',
        origin_server_ts: now - 8000,
        content: {
          memberships: [
            {
              application: 'm.call',
              call_id: '',
              scope: 'm.room',
              device_id: 'BOBDEV',
              expires: 3600000,
              foci_preferred: [
                {
                  type: 'livekit',
                  livekit_service_url: 'https://rtc.squadz.test/livekit/jwt',
                  livekit_alias: '!lounge:chat.squadz.test',
                },
              ],
            },
          ],
        },
      },
      // Bot's own membership (excluded via excludeUserId)
      {
        type: CALL_MEMBER_EVENT_TYPE,
        sender: '@soundboard:chat.squadz.test',
        state_key: '_@soundboard:chat.squadz.test_SBDEV_m.call',
        content: {
          application: 'm.call',
          device_id: 'SBDEV',
          created_ts: now - 1000,
          expires: 3600000,
        },
      },
    ];

    const active = findActiveCallMemberships(stateEvents, {
      now,
      excludeUserId: '@soundboard:chat.squadz.test',
    });

    assert.equal(active.length, 2);
    // Oldest membership first (bob, then alice)
    assert.equal(active[0].userId, '@bob:chat.squadz.test');
    assert.equal(active[0].deviceId, 'BOBDEV');
    assert.equal(active[1].userId, '@alice:chat.squadz.test');
    assert.equal(active[1].livekitAlias, '!lounge:chat.squadz.test');

    assert.equal(
      hasActiveCall(stateEvents, { now, excludeUserId: '@soundboard:chat.squadz.test' }),
      true
    );
    assert.equal(
      hasActiveCall(stateEvents.slice(0, 2), { now, excludeUserId: '@soundboard:chat.squadz.test' }),
      false
    );
  });
});

describe('Contract auth flow (Matrix login -> OpenID token -> lk-jwt-service /sfu/get)', () => {
  it('authenticates against mock homeserver and exchanges OpenID token for {url, jwt}', async () => {
    const requests = [];
    const mockFetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, method: init.method || 'GET', headers: init.headers, body });

      if (url === 'https://chat.squadz.test/_matrix/client/v3/login') {
        return new Response(
          JSON.stringify({
            user_id: '@soundboard:chat.squadz.test',
            access_token: 'syt_matrix_token',
            device_id: 'SBDEV01',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (
        url ===
        'https://chat.squadz.test/_matrix/client/v3/user/%40soundboard%3Achat.squadz.test/openid/request_token'
      ) {
        assert.equal(init.headers.Authorization, 'Bearer syt_matrix_token');
        return new Response(
          JSON.stringify({
            access_token: 'openid_secret_token',
            token_type: 'Bearer',
            matrix_server_name: 'chat.squadz.test',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url === 'https://rtc.squadz.test/livekit/jwt/sfu/get') {
        return new Response(
          JSON.stringify({
            url: 'wss://rtc.squadz.test/livekit/sfu',
            jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('not found', { status: 404 });
    };

    const matrix = new MatrixClient({
      homeserverUrl: 'chat.squadz.test',
      fetchImpl: mockFetch,
    });

    const loginRes = await matrix.login('soundboard', 's3cret', 'SBDEV01');
    assert.equal(loginRes.userId, '@soundboard:chat.squadz.test');
    assert.equal(loginRes.deviceId, 'SBDEV01');

    const openIdToken = await matrix.requestOpenIdToken();
    assert.equal(openIdToken.access_token, 'openid_secret_token');

    const lk = await fetchLiveKitJwt({
      rtcFqdn: 'rtc.squadz.test',
      roomId: '!lounge:chat.squadz.test',
      openIdToken,
      deviceId: matrix.deviceId,
      fetchImpl: mockFetch,
    });

    assert.equal(lk.url, 'wss://rtc.squadz.test/livekit/sfu');
    assert.equal(lk.jwt, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock');

    const sfuCall = requests.find((r) => r.url.endsWith('/livekit/jwt/sfu/get'));
    assert.ok(sfuCall);
    assert.deepEqual(sfuCall.body, {
      room: '!lounge:chat.squadz.test',
      openid_token: {
        access_token: 'openid_secret_token',
        token_type: 'Bearer',
        matrix_server_name: 'chat.squadz.test',
        expires_in: 3600,
      },
      device_id: 'SBDEV01',
    });
  });
});
