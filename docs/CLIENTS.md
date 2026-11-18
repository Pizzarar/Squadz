# Web/desktop client choice (P2 · C3a)

Decision for the client served at `https://CHAT_FQDN/`. Element X stays the mobile client.
Research date 2026-11-18. Every claim cites a file, release or issue I opened. Repo files were read from
shallow clones at the commits below, so a path is `repo@commit:path`.

| clone | commit |
|---|---|
| element-hq/element-web (`develop`) | `be6b455` (2026-11-17) |
| cinnyapp/cinny (`dev`) | `474400c` (2026-11-04) |
| commetchat/commet (`main`) | `5a87e83` (2026-11-15) |
| krille-chan/fluffychat (`main`) | HEAD on 2026-11-15 (`git log -1`: Sun Nov 15 2026) |

## Verdict

- **Pick: Cinny v4.12.8**. It is the only static web client that passes criteria 1 and 2 together: it embeds Element Call (voice/video/screen share) and reads and sends MSC2545 packs. It has the Discord-like Spaces sidebar and voice-room icons.
- **Runner-up: Element Web v1.12.35**. It has the best call interop with Element X (same Element Call code, newer build), but it has **no custom emoji or sticker packs at all**. Use it as the fallback if the Cinny call smoke test fails.
- Not a split: Cinny meets 1 and 2 on paper. The one open risk is call interop with Element X (see Risks), which C3b must smoke-test before the pick is final.

## Candidates

| client | status | verdict |
|---|---|---|
| Element Web | active, v1.12.35 (2026-11-12), RC v1.12.36-rc.0 on 2026-11-17 | runner-up |
| Cinny | active, v4.12.8 (2026-10-25), pushed 2026-11-17 | **pick** |
| Commet | active, v0.5.2 (2026-11-07) | rejected: web build is second-class (below) |
| FluffyChat | active, v2.11.5 (2026-11-06) | rejected: not Discord-like, calls on web unverified |
| Hydrogen (element-hq/hydrogen-web) | last release v0.5.1 on 2024-10-21 (`gh api .../releases/latest`) | dropped: no release in 2 years, no MatrixRTC |
| SchildiChat Desktop/Web | `SchildiChat/schildichat-desktop` is **archived** (`archived: true`, last release 2024-02-26); `schildichat-web` repo returns 404 | dropped: dead |
| Nheko | desktop-only Qt app, no static web build (`Nheko-Reborn/nheko`, last release v0.12.1, 2025-08-10) | dropped: not serveable as static files |

## Scores

Legend: PASS / PARTIAL / FAIL. Sources are in the per-client notes below.

| # | criterion | Element Web | **Cinny** | Commet | FluffyChat |
|---|---|---|---|---|---|
| 1 | MatrixRTC voice/video, our LiveKit focus, EX-interoperable | PASS (EC 0.28.2 bundled) | PASS (EC 0.20.1 bundled, older) | PARTIAL (native livekit_client, web unproven) | PARTIAL (livekit_client, web unverified) |
| 2 | MSC2545 emoji/stickers from Space/room packs | **FAIL** (no code) | PASS | PASS | PASS (emotes settings; stickers unchecked) |
| 3 | Spaces sidebar, Discord-like channels | PARTIAL (Spaces yes; classic chat layout) | PASS | PASS | PARTIAL |
| 4 | Screen share in calls | PASS (via EC) | PASS (button wired; issue #2767 was operator error) | PARTIAL (getDisplayMedia path exists; Windows audio capture in v0.5.1) | unverified |
| 5 | Static files, locked-down config | PASS (tarball + image, `disable_custom_urls`) | PASS (tarball + image, `allowCustomHomeservers:false`) | PARTIAL (`commet-web.tar.gz` exists; config model unclear) | not assessed |
| 6 | Maintenance | PASS | PASS | PASS (young, rapid releases) | PASS |
| 7 | Works with Tuwunel | PASS (no Tuwunel-specific blocker found) | PASS (Cinny's default `config.json` lists `#tuwunel:grin.hu` as a featured room) | unknown | unknown |

### Element Web v1.12.35
- Calls (1, 4): bundles `@element-hq/element-call-embedded` 0.28.2 (`element-web@be6b455:apps/web/package.json:125`), copied to `webapp/widgets/element-call` (`apps/web/webpack.config.ts:719-720`) and loaded from `./widgets/element-call/` (`apps/web/src/models/Call.ts:898`). So the widget is same-origin.
- Config: `element_call` has `use_exclusively`, `disable`, `brand`, `guest_spa_url` (`docs/config.md:395-410`). A labs flag `feature_matrixrtc_slots` only allows starting or joining calls when the room has a slot state event (`docs/labs.md:73-75`); our call rooms carry `m.rtc.slot`, so it is safe to leave off for the 3-person group.
- Emoji (2): `grep -rIl "im.ponies\|m.image_pack\|room_emotes"` over the whole clone returned **zero files**. No MSC2545 support. Open issues are old requests only (e.g. element-web#19747 "Add user configurable autocompletes", open since 2022).
- Lock-down (5): `default_server_config`, `disable_custom_urls`, `UIFeature.registration` and others in `docs/config.md`. Token registration is handled by `InteractiveAuth.tsx` / `InteractiveAuthEntryComponents.tsx` (grep for `RegistrationToken`).
- Hosting (5): image `ghcr.io/element-hq/element-web:v1.12.35` (manifest HEAD returned 200 on ghcr.io), tarball `element-v1.12.35.tar.gz` plus `.asc` (release assets, `gh api repos/element-hq/element-web/releases`). Docker image is nginx templated (`apps/web/docker/nginx-templates/default.conf.template`); `/config*` is served from `/tmp/element-web-config`.
- Headers: README requires `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` (`apps/web/README.md:20-23`, examples at 38 and 41).
- Tuwunel (7): searched element-web issues for "tuwunel OR conduwuit"; the hits (#35622, #35503, #35564) are not Tuwunel-caused as far as the titles show. #35622 "Messages not encrypted or sent" is open and unread in detail, so treat as unverified.

### Cinny v4.12.8
- Calls (1, 4): v4.11.1 (2026-03-11) release notes: "Feat: Add voice/video room support (PR #2680)" built on the Element Call library. Code: `@element-hq/element-call-embedded` **0.20.1** (`cinny@474400c:package.json`), copied to `public/element-call` (`vite.config.js`), iframe URL `${BASE_URL}/public/element-call/index.html` (`src/app/plugins/call/CallEmbed.ts:~125`). Iframe permissions: `allow = 'microphone; camera; display-capture; autoplay; clipboard-write;'` (`CallEmbed.ts:142`). Screen-share button in `src/app/features/call/CallControls.tsx:109-111`.
- Focus discovery: Cinny gates calls on `org.matrix.msc4143.rtc_foci` with a `livekit_service_url` in `/.well-known/matrix/client` (`src/app/hooks/useLivekitSupport.ts`). Our Caddy already serves exactly that key (`caddy/Caddyfile`, well-known block).
- Calls in any room: header call buttons `onVideoCall`/`onVoiceCall` call `startCall(room, ...)` (`src/app/features/room/RoomViewHeader.tsx:345-376`); issue #2743 "Video / Voice call in Direct Messages / Rooms" closed 2026-05-16.
- Call-member events: Cinny uses legacy `org.matrix.msc3401.call.member` (`src/app/plugins/call/utils.ts:42-76`) and `org.matrix.msc3417.call` as room type for its "voice room" icon (`src/types/matrix/room.ts:55`, `src/app/utils/room.ts:278`). **Our bootstrap marks call rooms with `m.rtc.slot`, not the msc3417 room type**, so Cinny will show them as ordinary text rooms with call buttons, not with the speaker icon. This is cosmetic only; joining still goes through Element Call. A follow-up for bootstrap (add the room type) would cost interop; see Risks.
- Emoji (2): reads/writes `im.ponies.room_emotes` (`src/types/matrix/room.ts` `PoniesRoomEmotes`, `src/app/hooks/useImagePacks.ts`, `src/app/plugins/custom-emoji/utils.ts`), pack editing UI in `src/app/features/common-settings/emojis-stickers/RoomPacks.tsx`, `m.sticker` send in `src/app/features/room/RoomInput.tsx:433-442`. B2's bootstrap writes the same event type, so packs seeded in the Space should appear.
- Spaces (3): `src/app/pages/client/sidebar/SpaceTabs.tsx`.
- Registration (5): `src/app/components/uia-stages/RegistrationTokenStage.tsx` implements `m.login.registration_token`.
- Config (5): `config.json` keys `defaultHomeserver` (index), `homeserverList`, `allowCustomHomeservers`, `featuredCommunities`, `hashRouter` (`config.json`, `src/app/hooks/useClientConfig.ts`). Default `featuredCommunities` points at public matrix.org rooms, so it must be emptied.
- Hosting (5): README says download the tarball and serve `dist/`. Asset `cinny-v4.12.8.tar.gz` (+`.asc`), image `ghcr.io/cinnyapp/cinny:v4.12.8` (manifest HEAD 200). Image is nginx with SPA fallback to `/index.html` (`docker-nginx.conf`). Cinny uses history routing by default (`hashRouter.enabled:false`).
- Maintenance (6): releases 4.12.6 (2026-08-01), 4.12.7 (2026-09-15), 4.12.8 (2026-10-25); repo pushed 2026-11-17. Cadence is roughly monthly and mostly dependency patches.
- Browser gotcha: cinny#2767 (screen-share button silent on Brave) was a `Permissions-Policy` header set in the reporter's nginx. So **do not send a Permissions-Policy that blocks camera, microphone or display-capture**.

### Commet v0.5.2
- Flutter app; web is built (`commet-web.tar.gz` in release v0.5.2) but the README platform list names only Windows, Linux and Android and the issue "Web instance broken" (#862, open, 2026-03-21) is unresolved. Another open web report: #1045 "Not able to send messages... after refreshing or closing tab" (2026-09-08).
- Calls: native `livekit_client` backend, reads `org.matrix.msc4143.rtc_foci` (`commet/lib/client/matrix/components/voip_room/matrix_livekit_backend.dart`). Uses `org.matrix.msc3401.call.member` and `msc3417` room type.
- Emoji: `im.ponies.room_emotes` in `matrix_emoticon_component.dart`; README lists "Custom Emoji + Stickers" and "Spaces".
- v0.5.1 notes: audio capture for screen sharing on Windows; v0.5.0 added "experimental support for encrypted Element Call".
- Verdict: best Discord-like **native desktop** client and a good optional extra for friends on Windows, but a Flutter web build with open breakage is a worse default than Cinny.

### FluffyChat v2.11.5
- README: "Video calls with Matrix RTC", Spaces; reads `im.ponies.room_emotes` (`lib/pages/settings_emotes`), uses `livekit_client`. Not Discord-like, and I did not verify the web call path, so it is not scored higher.

## Risks (must be checked in C3b / real-stack e2e)
1. **Cinny's Element Call is 0.20.1; Element Web ships 0.28.2.** Interop with Element X calls (which use a current Element Call) is likely but I did not find a Cinny/EX interop statement. C3b smoke: Cinny user and Element X user join the same `Lounge` and hear each other. If it fails, ship Element Web and note that custom emoji will not render in the web client (Element X also lacks them, so only the Cinny/Commet users see them).
2. **Pack event type.** Cinny/Commet/FluffyChat read `im.ponies.room_emotes`, matching bootstrap. A search snippet from the Matrix v1.19 release post (not opened in full) says the spec stabilised image packs under new type names (`m.image_pack`); no opened client source reads that type yet, so keep `im.ponies.room_emotes`.
3. **Voice-room icons.** See Cinny call-member note above; cosmetic.
4. Token registration in Cinny is code-present (`RegistrationTokenStage.tsx`), but I did not run it against Tuwunel. C1's e2e should cover registering via the Cinny flow only if cheap; the API path is already covered by bootstrap.

## C3b build input

**Pick: Cinny v4.12.8.**

Image (preferred): `ghcr.io/cinnyapp/cinny:v4.12.8` (pin by digest in compose once C3b resolves it; the docker tag exists).
Tarball alternative: `https://github.com/cinnyapp/cinny/releases/download/v4.12.8/cinny-v4.12.8.tar.gz` (+ `.asc`), serve the extracted `dist/`.

Caddy serves static files directly, so the tarball into a Caddy volume is also fine and avoids a second nginx. The image's nginx is the reference for rewrites only (`docker-nginx.conf`).

`config.json` (mounted over `/app/config.json` in the image, or placed next to `index.html`):

```json
{
  "defaultHomeserver": 0,
  "homeserverList": ["CHAT_FQDN"],
  "allowCustomHomeservers": false,
  "featuredCommunities": { "openAsDefault": false, "spaces": [], "rooms": [], "servers": [] },
  "hashRouter": { "enabled": false, "basename": "/" }
}
```

`CHAT_FQDN` is rendered from the env. `RTC_FQDN` does not appear in the client config: Cinny discovers the LiveKit focus from `https://CHAT_FQDN/.well-known/matrix/client` (`org.matrix.msc4143.rtc_foci[0].livekit_service_url = https://RTC_FQDN/livekit/jwt`), which Caddy already serves. Registration needs no config key; Tuwunel requires `TUWUNEL_REGISTRATION_TOKEN` and Cinny shows the token stage.

Element Call embedding config: none for Cinny. The widget is bundled under `/public/element-call/` and gets `baseUrl`, `roomId` etc. as URL parameters (`CallEmbed.ts`). No `element_call` / `features` keys exist in Cinny.

Caddy routing (inside the existing `https://{$CHAT_FQDN}` block; keep the current `/_matrix/*`, `/.well-known/matrix/*` and `/golive/*` handles **above** the catch-all):

```caddyfile
handle {
	root * /srv/cinny
	header {
		X-Frame-Options SAMEORIGIN
		Content-Security-Policy "frame-ancestors 'self'"
		Referrer-Policy no-referrer
		X-Content-Type-Options nosniff
	}
	header /config.json Cache-Control no-cache
	header /index.html Cache-Control no-cache
	try_files {path} /index.html
	file_server
}
```

- Root (`/`) with SPA fallback: Cinny's `build.config.ts` sets `base: '/'` and history routing is on, so it must be at the host root, not `/web`, and unknown paths must fall back to `index.html`.
- `X-Frame-Options: SAMEORIGIN` plus `frame-ancestors 'self'` is required because Element Call runs in a same-origin iframe (`CallEmbed.ts` builds the URL from `window.location.origin`). `DENY` would break calls. Do **not** add `Permissions-Policy` for camera, microphone or display-capture (cinny#2767).
- Do **not** add a restrictive `Content-Security-Policy` beyond `frame-ancestors`: Element Call and the LiveKit WebSocket (`wss://RTC_FQDN/livekit/sfu`) plus WebRTC are cross-origin. If a full CSP is wanted later, test it against a live call first.
- `/golive/*` already is served from `/srv/golive`; it keeps its own `handle_path` so Cinny's catch-all must come after it.
- `.wasm`/`.js` content types are handled by Caddy's `file_server`; no COOP/COEP headers were found in Cinny's nginx config, so none are needed.
- Mount: add a read-only volume `./web/cinny` (extracted release) or `cinny` image copy to `/srv/cinny`, and `config/web-client/config.json` as `/srv/cinny/config.json`.

## Fallback build input: Element Web v1.12.35
- Image `ghcr.io/element-hq/element-web:v1.12.35` or tarball `element-v1.12.35.tar.gz`.
- `config.json`:
```json
{
  "default_server_config": {
    "m.homeserver": { "base_url": "https://CHAT_FQDN", "server_name": "CHAT_FQDN" }
  },
  "disable_custom_urls": true,
  "disable_guests": true,
  "disable_3pid_login": true,
  "show_labs_settings": false,
  "integrations_ui_url": null,
  "integrations_rest_url": null,
  "integrations_widgets_urls": [],
  "room_directory": { "servers": ["CHAT_FQDN"] },
  "element_call": { "use_exclusively": true, "brand": "Squadz Call" },
  "setting_defaults": { "UIFeature.registration": true, "UIFeature.passwordReset": false, "UIFeature.identityServer": false }
}
```
  Omit `m.identity_server` (the sample points at vector.im). Same Caddy block as above (root, SPA fallback, `X-Frame-Options SAMEORIGIN`, `frame-ancestors 'self'`). Element Web also needs `/config*` not cached and `/usercontent/` served (`apps/web/docker/nginx-templates/default.conf.template`); with the tarball both are plain static files.

## Out of scope / notes
- Element Desktop is the same codebase as Element Web, so choosing Cinny also means desktop users use the browser/PWA or Cinny Desktop (`cinnyapp/cinny-desktop`, not assessed). Commet native desktop is the Discord-like alternative for Windows friends.
- No change to the P1 contract (hostnames, ports, env, services).
