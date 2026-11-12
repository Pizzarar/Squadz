# P1 · Foundation (Squadz Meet)

Owner: Overlord (hub lead, `team-squadz-meet`). Started 2026-11-08. Owner (Aub) asked for a full
VibeSquad build that gets as far as possible without them; the lead makes the open design calls.

## Goal
A complete, statically verified repo: stack + config, seeding/onboarding, soundboard bot and a
high-FPS "go live" streaming page. Once Aub supplies a domain, DNS token and a host, it deploys with
`cp .env.example .env && docker compose up -d && node scripts/bootstrap.mjs`.

## Decided (lead, owner-delegated)
- **Hostnames**: two subdomains under `SQUADZ_DOMAIN`. `CHAT_FQDN` (default `chat.<domain>`) serves
  Tuwunel and `/.well-known/matrix/*`. `RTC_FQDN` (default `rtc.<domain>`) serves LiveKit + JWT service.
  Subdomains over single-FQDN path routing, because Element's MatrixRTC docs and lk-jwt-service
  assume a dedicated RTC host, and DNS-01 issues certs for both without any inbound port.
- **Matrix server_name = `CHAT_FQDN`**, so the apex domain stays free for other use.
  User IDs look like `@aub:chat.<domain>`. Well-known is served on `CHAT_FQDN` itself.
- **DNS**: public A records `CHAT_FQDN` and `RTC_FQDN` → `MESH_IP` (CGNAT 100.x address). Only mesh
  peers can route to it; no mesh-DNS coupling. ACME uses DNS-01, so nothing is exposed publicly.
- **Federation off**. Registration only with `TUWUNEL_REGISTRATION_TOKEN`.
- **Ports**, all bound to `MESH_IP` only: `443/tcp` (Caddy), `7881/tcp` (LiveKit ICE/TCP fallback),
  `50000-50100/udp` (LiveKit RTP). No port 80, no TURN (everyone is on the mesh).
- **TLS**: Caddy built with xcaddy + `caddy-dns/cloudflare` by default; `DNS_PROVIDER` documented as
  swappable (Dockerfile build arg).
- **Host**: assume a Linux Docker host (or WSL2/Docker Desktop, documented with caveats). Aub's actual
  host is an open question.
- **Primitives checked**: `vs --help` has no worktree verb in this build, so the lead creates git
  worktrees in `~\.paseo\worktrees\squadz\` (same sanctuary as other projects). No existing skill or VS
  primitive covers Matrix/LiveKit work.

## Contract (shared by every block; change only with a note in the final message)
Env (`.env.example`): `SQUADZ_DOMAIN`, `CHAT_FQDN`, `RTC_FQDN`, `MESH_IP`, `ACME_EMAIL`,
`CLOUDFLARE_API_TOKEN`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `TUWUNEL_REGISTRATION_TOKEN`,
`SQUADZ_ADMIN_USER`, `SQUADZ_ADMIN_PASSWORD`, `SOUNDBOARD_MATRIX_USER`, `SOUNDBOARD_MATRIX_PASSWORD`,
`SOUNDBOARD_CLIPS_DIR` (default `./bots/soundboard/clips`).

Compose services: `caddy`, `tuwunel`, `livekit`, `lk-jwt-service`, `soundboard` (`profiles: [bots]`,
`build: ./bots/soundboard`, env `SOUNDBOARD_*`, `CHAT_FQDN`, `RTC_FQDN`, clips volume read-only at
`/clips`).

Routing (Caddy):
- `https://CHAT_FQDN/_matrix/*` → `tuwunel:6167`
- `https://CHAT_FQDN/.well-known/matrix/client` → JSON with `m.homeserver.base_url = https://CHAT_FQDN`
  and `org.matrix.msc4143.rtc_foci = [{type: "livekit", livekit_service_url: "https://RTC_FQDN/livekit/jwt"}]`
- `https://CHAT_FQDN/golive/*` → static files from `web/golive/` (block B4)
- `https://RTC_FQDN/livekit/jwt/*` → `lk-jwt-service:8080` (prefix stripped)
- `https://RTC_FQDN/livekit/sfu/*` → `livekit:7880` (prefix stripped, websockets)

Auth for non-Element clients (bot and go-live page): Matrix login → `POST /_matrix/client/v3/user/{id}/openid/request_token`
→ `POST https://RTC_FQDN/livekit/jwt/sfu/get` with `{room, openid_token, device_id}` → `{url, jwt}`.
Each package implements its own copy (small; no shared package yet).

Seeded Space (B2): Space "Squadz" with rooms `#general`, `#games`, `#clips`, `#memes`, and voice rooms
`Lounge` and `Game Night` (MatrixRTC call rooms). Room aliases: `#<name>:CHAT_FQDN`.

## Blocks
| Block | Lane | Profile | Touches | Clashes with |
|---|---|---|---|---|
| B1 Core stack | homeserver-voice + mesh-certs | Implement - Sonnet | `docker-compose.yml`, `.env.example`, `.gitignore`, `caddy/**`, `config/**`, `scripts/validate.mjs`, `docs/SETUP.md`, `README.md`, `.github/workflows/ci.yml` | none |
| B2 Seed + onboarding | channels-client-ux | Work Order - DSP | `scripts/bootstrap.mjs`, `scripts/lib/**`, `scripts/test/**`, `scripts/package.json`, `docs/ONBOARDING.md`, `assets/emoji/**` | none |
| B3 Soundboard bot | soundboard-bots | Implement - Sonnet | `bots/soundboard/**` | none |
| B4 Go-live streaming | game-streaming | Implement - Gemini (trial) | `web/golive/**`, `docs/STREAMING.md` | none |

All four run in parallel: disjoint files, and the contract above pins every cross-block name.
`CREDITS.md` is written by the lead at merge time from each worker's final message.

### B1 · Core stack
Write the full stack per the contract. Pin image tags (no `latest`): Tuwunel, LiveKit server,
lk-jwt-service (`ghcr.io/element-hq/lk-jwt-service`), Caddy. Tuwunel: federation off, token
registration, RocksDB volume, MatrixRTC/well-known settings if Tuwunel supports them natively (check
its docs; Caddy serves the well-known either way). LiveKit: `rtc.node_ip: ${MESH_IP}`,
`use_external_ip: false`, port range 50000-50100, tcp 7881, keys from env. lk-jwt-service:
`LIVEKIT_URL=wss://RTC_FQDN/livekit/sfu`, `LIVEKIT_FULL_ACCESS_HOMESERVERS=CHAT_FQDN`.
`scripts/validate.mjs` (Node, no deps or a vendored YAML parser in `scripts/package.json` shared with
B2: B1 owns only `validate.mjs`; if it needs `yaml`, say so and the lead adds it): every compose
`${VAR}` defined in `.env.example`; every published port bound to `${MESH_IP}`; no `latest` tags;
`.env` gitignored. CI (`ubuntu-latest`): `docker compose config`, build caddy, `caddy validate`,
and `docker compose up -d tuwunel livekit lk-jwt-service` + health checks with a throwaway `.env`.
`docs/SETUP.md`: mesh setup (Meshnet and Tailscale), domain + Cloudflare token, DNS records, first
boot, troubleshooting (DNS rebinding protection on routers, Windows/WSL2 UDP notes).
Done check: `node scripts/validate.mjs` exits 0 and prints its checks.

### B2 · Seed + onboarding
`scripts/bootstrap.mjs`: idempotent. Registers admin (token) if missing, creates the Space + rooms from
the contract (sets `m.space.child`/`m.space.parent`, aliases, sensible power levels, `#clips` for the
bot), invites listed friends (`--invite @a:… @b:…`), creates an emoji pack room state
(`im.ponies.room_emotes`, MSC2545) from `assets/emoji/*.png` (upload via media API). Uses only
`fetch`. Unit tests (`node --test`) against an in-process mock homeserver covering idempotency (second
run creates nothing). `docs/ONBOARDING.md`: friend guide for Element X (iOS/Android) and Element
desktop: join the mesh, sign up with the token, join the Space, start voice, enable custom emoji.
Done check: `cd scripts && npm test` green.

### B3 · Soundboard bot
Node 20 + TypeScript or plain ESM, `@livekit/rtc-node` to publish audio, Matrix client via `fetch`
(or `matrix-bot-sdk` if justified). Behaviour: listens in rooms it is invited to; `!sb list`,
`!sb play <clip>`, `!sb stop`; joins the room's active MatrixRTC call (post the `org.matrix.msc3401.call.member`
state per MSC4143, get a LiveKit JWT through the contract auth flow), decodes the clip with ffmpeg to
48 kHz PCM and publishes it, leaves after idle timeout. Clips from `/clips` (mp3/ogg/wav). Dockerfile
(node slim + ffmpeg). Tests: command parsing, clip registry, PCM framing, call-member event shape,
auth flow against a mock. `bots/soundboard/README.md`.
Done check: `cd bots/soundboard && npm test` green.

### B4 · Go-live streaming
Research first, then build. `docs/STREAMING.md`: what Element X / Element Call can do for screen share
today (resolution, fps, system audio), LiveKit server/codec settings for 1080p60 and 1440p60 (VP9/AV1
vs H.264, simulcast layers, bitrate), and mesh bandwidth math for 3 viewers, with sources.
`web/golive/`: static page using `livekit-client` (vendored ESM build, no bundler needed or a
committed build output) that logs in with Matrix credentials, gets a JWT via the contract auth flow
for a chosen room, and publishes `getDisplayMedia` with system audio at a selectable 1080p60/1440p60
preset; viewers in the same room see it in Element Call. Include a viewer mode. Tests for the pure
logic (preset → encoding params, auth flow against a mock) with `node --test`.
Done check: `cd web/golive && npm test` green.

## Phase 2 (after merge)
Integration review, CI run on GitHub (needs push approval), Aub provisioning (domain, token, host),
first deploy, Element X phone check with 3 friends.

## In flight
- 2026-11-09: P1 PAUSED by Aub. All four workers stopped; worktrees kept (b3, b4 have 1 uncommitted file each, nothing committed).
- Restart is gated on VibeSquad idea-162 (worker context handoff; today only role=lead auto-hands off). Hub9 will `vs send` when it merges.
- Restart rules until then: spawn fresh workers with a brief (do not resume the old sessions), keep units small,
  and the lead re-spawns any worker that passes ~150k. Split B4 into B4a (STREAMING.md research) then B4b (golive page).
- 2026-11-12: P1 resumed after the VS restart (f736924). State at Overlord handoff (~04:45Z):
  - B1: built (87a1cba, 6820b9f; validate 9/9). Review FAIL: `TUWUNEL_GLOBAL__*` env prefix ignored, `node_ip: ${MESH_IP}` not expanded by LiveKit. Fix worker rn-fc24dcd7f7a3 (DSP) running. Next: re-review with Review - Gemini.
  - B2: built (e32c9d3, 37c8a44; 6/6). Review FAIL: MSC2545 schema, key-order idempotency, call-room type + rtc.member PLs, UIA + restricted joins, MXID parsing, onboarding order. Fix worker rn-5322c4bd6bdf (DSP) running. Next: re-review.
  - B3: built (989c09b..0182948; 23/23). Review rn-f21f44720333 (Gemini) running.
  - B4a: Gemini worker died on API EOF; Sonnet worker rn-c6da1b38ae74 (failed over to Gemini under the Claude cap) running. Then B4b golive page from STREAMING.md section 6.
  - Merge order once each review passes: B1, B2, B3, B4 into dev; write CREDITS.md from the workers' credits lines.
  - Claude capped until 07:00Z: new Claude spawns queue on Gemini (3 concurrent). Prefer Work Order - DSP for clear-scope fixes.
