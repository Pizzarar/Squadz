# High-FPS Game & Screen Streaming (`docs/STREAMING.md`)

Squadz includes a **Go-Live** web page served at `https://<CHAT_FQDN>/golive/` for 1080p60 / 1440p60 game
streaming with stereo system audio over the LiveKit SFU (`https://<RTC_FQDN>`).

**Evidence labels.** Every figure below is one of: `[src: <url or file>]` (page or file actually opened while
writing this revision), `[assumption]`, `[starting value, tune]` (our own pick, not measured) or
`[unverified]` (plausible, no source opened). Nothing here has been measured on a real mesh yet.
`web/golive/lib/presets.mjs` does **not exist yet**; B4b creates it and its tests.

---

## 1. Element X & Element Call Screen-Share Limits Today

Element X and Element Desktop/Web use Element Call (MatrixRTC, `livekit-client`) for calls. Contract:
`docs/plans/P1-foundation.md` on `dev` (well-known advertises `org.matrix.msc4143.rtc_foci`).

1. **`livekit-client` defaults** `[src: client-sdk-js src/room/track/options.ts]`. `ScreenSharePresets` are:

   | Preset | Resolution | maxBitrate | maxFramerate |
   | :--- | :--- | :--- | :--- |
   | `h720fps5` | 1280×720 | 0.8 Mbps | 5 |
   | `h720fps15` | 1280×720 | 1.5 Mbps | 15 |
   | `h720fps30` | 1280×720 | 2.0 Mbps | 30 |
   | `h1080fps15` | 1920×1080 | 2.5 Mbps | 15 |
   | `h1080fps30` | 1920×1080 | 5.0 Mbps | 30 |
   | `original` | native | 7.0 Mbps | 30 |

   (`h360fps3` 0.2 Mbps/3 fps and `h360fps15` 0.4 Mbps/15 fps also exist.) No preset exceeds 30 fps, so
   anything using presets as-is tops out at 30 fps. Screen-share capture resolution defaults to 1080 for
   all browsers except Safari `[src: options.ts, ScreenShareCaptureOptions.resolution]`.
2. **Degradation preference** `[src: options.ts]`: when `degradationPreference` is unset, the SDK picks
   `maintain-framerate` for camera, `maintain-resolution` for screen share, `balanced` otherwise. For
   fast game motion, set `maintain-framerate` explicitly; keep `maintain-resolution` for text-heavy shares.
3. **Audio**: `ScreenShareCaptureOptions.audio` and `systemAudio?: 'include' | 'exclude'` exist
   `[src: options.ts]`. Mono tracks get `dtx` and `red` on by default and stereo is governed by `forceStereo`
   / capture channel count `[src: options.ts]`. Audio presets: `music` 48 kbps, `musicStereo` 64 kbps,
   `musicHighQuality` 96 kbps, `musicHighQualityStereo` 128 kbps `[src: options.ts]`.
4. **Element Call / Element X specifics** (all `[unverified]`; I did not find a release note or source file
   that states them, a web search turned up nothing conclusive on 2026-11-12):
   - Element Call UI exposes no 1080p60/1440p60 selector or bitrate/framerate override.
   - Whether Element Call's screen share carries system audio, and at what bitrate/channel count.
   - Element X mobile embeds Element Call in a WebView and cannot *publish* `getDisplayMedia` screens.
     Viewing a LiveKit screen share on mobile should work through normal WebRTC decode `[unverified]`.
   - Verify on a real phone before relying on any of this (Phase 2 "Element X phone check").

Because Go-Live and Element Call use the same LiveKit SFU and the same lk-jwt-service/MatrixRTC
membership (section 6), friends can watch in Element Call or in Go-Live Viewer Mode. Whether Element Call
renders a *screen-share* tile from a third-party publisher is `[unverified]` (section 6, "Interop risk").

---

## 2. LiveKit Codec, Simulcast/SVC, and Bitrate Settings

### Codecs

| Codec | Compression vs H.264 | Scalability | Notes |
| :--- | :--- | :--- | :--- |
| **VP9** (`vp9`) | better, magnitude `[unverified]`, 30–40% commonly quoted | SVC, default `L3T3_KEY` `[src: options.ts scalabilityMode]` | Proposed default `[starting value, tune]` |
| **AV1** (`av1`) | better still, magnitude `[unverified]` | SVC, same `scalabilityMode` | Needs capable encoder/decoder on both sides; test before offering |
| **H.264** (`h264`) | baseline | simulcast | Widest hardware decode, incl. older phones `[unverified]` |

`videoCodec` is a publish option "defaults to vp8; for svc codecs, auto enable vp8" and `backupCodec`
defaults to `true` `[src: options.ts]`, so a `vp9` or `av1` publish also publishes a VP8 backup layer for
clients that cannot decode it. Hardware-encode support per GPU vendor is `[unverified]`; Chromium picks
the encoder, we do not control it.

### Simulcast vs. SVC

- `simulcast` defaults to `true`; `screenShareSimulcastLayers` customises screen-share layers
  `[src: options.ts]`. `scalabilityMode` applies to SVC codecs (VP9/AV1), default `L3T3_KEY`
  `[src: options.ts]`.
- Effect on streamer uplink: the SFU forwards one stream per viewer, so viewer count does not change
  streamer upload; extra layers (simulcast or backup codec) *add* uplink. Exact overhead of each
  `[unverified]`. For a 4-person squad on a fast link, start single-layer (`simulcast: false`) and
  measure `[starting value, tune]`.
- A small squad on the mesh rarely needs low layers; they exist as a fallback for a weak viewer.

### Encoding presets (Go-Live)

All bitrates below are `[starting value, tune]`, chosen by me, not measured and not from a source. The
SDK reference points are `h1080fps30` = 5.0 Mbps and `original` = 7.0 Mbps `[src: options.ts]`.
The old 1080p30 value (3.5 Mbps) is kept as the VP9 figure and is deliberately *below* the SDK's 5.0 Mbps
`h1080fps30` default (which is tuned for VP8) `[starting value, tune]`.

| Preset ID | Resolution | FPS | Video bitrate VP9/AV1 | Video bitrate H.264 | Audio |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `1080p60` | 1920×1080 | 60 | 6.0 Mbps | 8.0 Mbps | stereo Opus 128 kbps |
| `1440p60` | 2560×1440 | 60 | 10.0 Mbps | 14.0 Mbps | stereo Opus 128 kbps |
| `1080p30` | 1920×1080 | 30 | 3.5 Mbps | 4.5 Mbps | stereo Opus 128 kbps |

Audio is 128 kbps because the SDK's top preset `musicHighQualityStereo` is 128_000 `[src: options.ts]`
(the draft's 160 kbps had no source and is dropped). DTX off for stereo music `[starting value, tune]`.

Publish options Go-Live sets (names from `[src: options.ts]`; values per above):
`screenShareEncoding: { maxBitrate, maxFramerate, priority: 'high' }`, `videoCodec`, `backupCodec`,
`degradationPreference: 'maintain-framerate'`, `simulcast: false`, `forceStereo: true`,
`audioPreset: AudioPresets.musicHighQualityStereo`. Capture constraints: see section 6.

---

## 3. Browser System-Audio Capture Support

Per MDN `[src: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia]`:
`audio: true` returns an audio track only "if audio is supported and available for the display surface
chosen by the user"; `systemAudio` and `windowAudio` are **hints** the browser "may ignore", so the stream
can have no audio track even with `audio: true` and `systemAudio: "include"`. On Chrome `systemAudio:
"exclude"` removes system audio from the picker. MDN notes support varies by browser and audio source.
**Go-Live must therefore check `stream.getAudioTracks().length` after capture and tell the user when it is 0.**

The per-OS rows below are *expectations*, not verified compat data. I did not open the MDN browser
compatibility table (it was not in the fetched text) or Chrome release notes.

| Platform & browser | Entire-screen audio | Window audio | Tab audio | Status |
| :--- | :--- | :--- | :--- | :--- |
| Windows, Chrome/Edge | expected to work ("Also share system audio" checkbox) | hint-dependent | expected | `[unverified]`, minimum Chrome version unverified |
| macOS, Chrome/Edge | system audio: version/OS requirements | n/a | expected | `[unverified]` (earlier draft's "macOS 13+ / Chrome 132+" had no source and is dropped) |
| Linux, Chrome | tab audio expected; system audio depends on OS/PipeWire | n/a | expected | `[unverified]` |
| Firefox | `[unverified]`, treat as no system audio | n/a | n/a | `[unverified]` |
| Safari | `[unverified]`, treat as view-only | n/a | n/a | `[unverified]` |

Action for B4b: ship a **"Test capture"** button that reports resolution, fps (`track.getSettings()`) and
audio-track presence, and recommend Chrome/Edge on Windows as the supported publisher until a real test
says otherwise.

---

## 4. Upload Bandwidth Math: 1 Streamer to 3 Viewers over the Mesh

Mesh: WireGuard-based (NordVPN Meshnet = NordLynx, or Tailscale). MTU: NordLynx 1420 `[unverified]`,
Tailscale 1280 `[unverified]`. Smaller MTU means more packets and more header overhead.

Let:
- $B_{\text{video}}$ = section 2 video bitrate
- $B_{\text{audio}}$ = 0.128 Mbps
- $O_{\text{mesh}} = 1.07$: **7% is an assumption** for RTP/SRTP/UDP/WireGuard headers plus NACK/RTCP
  `[assumption]`. At 1280 MTU on Tailscale expect somewhat more.
- $B_{\text{stream}} = (B_{\text{video}} + B_{\text{audio}}) \times O_{\text{mesh}}$

LiveKit is an SFU on the Squadz host (`MESH_IP`), so for 1 streamer + 3 viewers:

- **Case A, streamer is a separate peer**: streamer uploads $1\times B_{\text{stream}}$; the SFU host
  uploads $3\times B_{\text{stream}}$.
- **Case B, streamer is the SFU host**: streamer input is local loopback; host uploads $3\times B_{\text{stream}}$.

| Preset & codec | Raw (V+A) | $B_{\text{stream}}$ | Streamer upload (Case A) | SFU host upload ×3 | Min. upload line, headroom rounded up |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1080p60 VP9/AV1 | 6.13 Mbps | 6.56 Mbps | 6.6 Mbps | 19.7 Mbps | 25 Mbps host / 10 Mbps remote streamer |
| 1080p60 H.264 | 8.13 Mbps | 8.70 Mbps | 8.7 Mbps | 26.1 Mbps | 35 Mbps host / 12 Mbps remote streamer |
| 1440p60 VP9/AV1 | 10.13 Mbps | 10.84 Mbps | 10.8 Mbps | 32.5 Mbps | 42 Mbps host / 15 Mbps remote streamer |
| 1440p60 H.264 | 14.13 Mbps | 15.12 Mbps | 15.1 Mbps | 45.4 Mbps | 58 Mbps host / 20 Mbps remote streamer |

Arithmetic: ×1.07, ×3, then ×1.25 headroom (a `[starting value, tune]` margin), **rounded up** to a
convenient number (so 19.7×1.25 = 24.6 → 25, and 6.56×1.25 = 8.2 → 10 remote streamer).
Mic voice is ~negligible next to video (Opus voice rate `[unverified]`).

---

## 5. Recommended `livekit.yaml` Changes

`config/livekit.yaml` belongs to B1. The current `dev` file does not set `enabled_codecs`. LiveKit's
sample config marks it optional (lead brief; not re-opened here), and defaults allow vp9/av1/h264, so
**no codec list is needed and none is recommended**. The earlier draft's `video/rtx` "must be listed or
streams freeze" warning cited livekit#2581, which is an unrelated PR; the claim is **removed** because
no real source was found for it.

Only optional tuning remains:

```yaml
rtc:
  # Larger video packet buffer so NACK retransmits survive keyframe bursts at 60 fps.
  # Field name/default taken from memory of config-sample.yaml, not re-opened: [unverified]
  packet_buffer_size_video: 1000   # [starting value, tune]
```

Verify the key exists in the pinned LiveKit image's `config-sample.yaml` before adding it; an unknown key
may be ignored or rejected depending on the server version. Not required for B4b.

---

## 6. Go-Live Page Build Spec (`web/golive/`, for B4b)

Static ES modules served by Caddy at `https://<CHAT_FQDN>/golive/`; no bundler. `livekit-client` is vendored as
`web/golive/vendor/livekit-client.esm.mjs` (pin the version in `web/golive/package.json` and in a comment at the top of the vendored file).

### Files
```
web/golive/
  index.html            # the 4 views below, no inline script
  app.mjs               # DOM wiring + state machine
  styles.css
  vendor/livekit-client.esm.mjs
  lib/presets.mjs       # preset id -> { width,height,fps, maxBitrate by codec, audio } ; encodingFor(preset, codec)
  lib/matrix.mjs        # login, resolveRoom, openidToken, sendCallMember, clearCallMember
  lib/lkjwt.mjs         # fetchSfuToken (shape below)
  lib/capture.mjs       # captureConstraints(preset), startCapture()
  lib/publish.mjs       # publish/stop with livekit-client
  package.json          # "test": "node --test"
  test/*.test.mjs       # presets, matrix/lkjwt against mock fetch, call.member shape
```
Pure logic (`presets`, `matrix`, `lkjwt`, `callMemberContent`) must not touch `window`/`document` so `node --test` can run it with an injected `fetch`.

### UI states
1. `login` (homeserver defaults to `window.location.origin` since the page is served static from `https://<CHAT_FQDN>/golive/`; username, password; room selector defaults to `#game-night:<server_name>`, also `#lounge`, plus a paste field) → error text on failure.
2. `lobby` (mode toggle **Stream / Watch**; preset select `1080p60|1440p60|1080p30`; codec select `vp9|av1|h264`; "Test capture").
3. `streaming` (local preview `<video muted>`, stats: width×height, fps, bitrate from `getStats`, audio-track present yes/no, Stop button).
4. `watching` (grid of remote video elements, per-stream volume, Leave button).
Errors surface inline; "Stop" always clears the call.member event (below).

### Auth flow (`lib/matrix.mjs`, `lib/lkjwt.mjs`)
Source of the shape: working copy in `unit/b3` `bots/soundboard/src/matrixrtc.js` (`fetchLiveKitJwt`).
1. `POST /_matrix/client/v3/login` `{ type: "m.login.password", identifier: { type: "m.id.user", user }, password, initial_device_display_name: "Squadz Go-Live" }` → `{ access_token, user_id, device_id }`.
2. Room: accept a roomId (`!…:<CHAT_FQDN>`) or an alias. **An alias cannot contain a space**, so `#Game Night:…` is invalid; use the alias the seed created (the exact slug is set by B2 `bootstrap.mjs`, not confirmed here `[unverified]`), e.g. `#game-night:<CHAT_FQDN>`, via `GET /_matrix/client/v3/directory/room/{url-encoded alias}` → `{ room_id }`. Let the user also paste a roomId directly.
3. `POST /_matrix/client/v3/user/{user_id}/openid/request_token` body `{}` → `{ access_token, token_type, matrix_server_name, expires_in }`.
3b. Resolve the service URL at runtime: `GET <homeserver>/.well-known/matrix/client` → `org.matrix.msc4143.rtc_foci[type=livekit].livekit_service_url` (no build-time FQDN templating; Caddy serves this doc).
4. `POST <livekit_service_url>/sfu/get` (i.e. `https://<RTC_FQDN>/livekit/jwt/sfu/get`), `Content-Type: application/json`, body
   `{ "room": "<Matrix roomId>", "openid_token": <step-3 object, verbatim>, "device_id": "<device_id>" }` → `{ url, jwt }`.
   - Compose pins `ghcr.io/element-hq/lk-jwt-service:0.4.4` (`dev:docker-compose.yml:70`). `room` must be the **Matrix roomId, not an alias** (lead note: 0.4.4 hashes it).
   - Source read for the identity/room mapping (a summary of `main.go` at tag `v0.4.4`, not the raw file read by me): legacy `/sfu/get` builds the LiveKit identity as `<user_id>:<device_id>` and the LiveKit room name as SHA-256 (unpadded base64) of `["<room>", "m.call#ROOM"]`. Treat `[unverified]` until confirmed against the running container; B4b's mock test should only assert the request body, not the hashing.
   - Connect with `new Room()` then `room.connect(url, jwt)`.

### Matching Element Call: `org.matrix.msc3401.call.member`
So that Element Call clients see the Go-Live participant as a room-call member, send the state event
(`PUT /_matrix/client/v3/rooms/{roomId}/state/org.matrix.msc3401.call.member/{state_key}`) using the shape
already used by the B3 bot (`unit/b3` `bots/soundboard/src/matrixrtc.js`, `buildCallMemberStateKey` / `buildCallMemberContent`):
- `state_key`: `_<user_id>_<device_id>_m.call`
- content: `{ application: "m.call", call_id: "", scope: "m.room", device_id, expires: 14400000 (4 h, refresh before expiry), created_ts: <ms>, focus_active: { type: "livekit", focus_selection: "oldest_membership" }, foci_preferred: [ { type: "livekit", livekit_service_url: "https://<RTC_FQDN>/livekit/jwt", livekit_alias: "<roomId>" } ] }`
  (note the field is spelled `focus_active` in b3 code; the key the task text calls `foci_active` was not confirmed in either spelling in a spec `[unverified]`; follow b3 unless the Element Call interop test shows otherwise).
- On Stop/disconnect, `PUT` the same state_key with `{}` to leave. The page re-PUTs every 3 h (before the 4 h expiry). A 403 / `M_FORBIDDEN` on this PUT is shown as a clear "no permission to start a call in this room" error and aborts the stream (build addition: `friendlyStateError`).
- `lib/*` tests assert byte-for-byte parity with `bots/soundboard/src/matrixrtc.js` (`buildCallMemberContent`, `fetchLiveKitJwt` request).
- **Interop risk `[unverified]`:** whether Element Call shows a screen-share tile from a publisher that is not Element Call itself (track source `screen_share`, participant identity format) is untested; Viewer Mode in Go-Live is the guaranteed fallback. Record the result of the first real test in this doc.

### Capture (`lib/capture.mjs`)
```js
navigator.mediaDevices.getDisplayMedia({
  video: { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: FPS, max: FPS } },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
  systemAudio: 'include', windowAudio: 'system',     // hints, may be ignored (section 3)
  selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
})
```
(W,H,FPS from the preset.) The `systemAudio` / `windowAudio` / `monitorTypeSurfaces` / `surfaceSwitching` members are MDN hints `[src: MDN getDisplayMedia]`; Chrome-only members are ignored elsewhere. After capture: set `videoTrack.contentHint = 'motion'`; warn if `getAudioTracks().length === 0`; read back `getSettings()` and show it (the browser may deliver less than `ideal`).

### Publish (`lib/publish.mjs`)
Prefer manual `publishTrack` so encoding and degradation are explicit:
```js
const room = new Room();
await room.connect(url, jwt);
const [vt] = stream.getVideoTracks(), [at] = stream.getAudioTracks();
await room.localParticipant.publishTrack(vt, {
  source: Track.Source.ScreenShare,
  videoCodec: codec,               // 'vp9' | 'av1' | 'h264'
  backupCodec: true,               // SDK default per options.ts
  simulcast: false,                // [starting value, tune]
  screenShareEncoding: { maxBitrate, maxFramerate: fps, priority: 'high' },
  degradationPreference: 'maintain-framerate',
});
if (at) await room.localParticipant.publishTrack(at, {
  source: Track.Source.ScreenShareAudio, forceStereo: true, dtx: false, red: false,
  audioPreset: AudioPresets.musicHighQualityStereo,
});
```
Option names are from `options.ts`; `Track.Source.*` names `[unverified: not opened]`. The alternative
`room.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions)` takes the same option
objects but lets the SDK call `getDisplayMedia` itself; use it only if manual publish proves problematic.
Listen for `RoomEvent.Disconnected` and `track.onended` to tear down and clear the call.member event.

### Viewer mode
Same login/room/JWT flow (step 4), then `room.connect`; no capture, no publish. Subscribe to
`RoomEvent.TrackSubscribed` and `attach()` video/audio to elements; show participant identity and a Leave button.
A viewer should *not* send a call.member event (Element Call users already did).

---

## 7. Sources & References

Opened and used in this revision:
1. client-sdk-js `src/room/track/options.ts` — `ScreenSharePresets`, `VideoPresets`, `AudioPresets`, `TrackPublishOptions` defaults (`backupCodec`, `scalabilityMode`, `degradationPreference`, `simulcast`), `ScreenShareCaptureOptions`: <https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts> (fetched via raw.githubusercontent.com, summarised by the fetch tool, not read byte-for-byte).
2. MDN `MediaDevices.getDisplayMedia()`: <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia> (compat table not in fetched text).
3. element-hq/lk-jwt-service README (config, deprecations) and `main.go` at `v0.4.4` (summary only): <https://github.com/element-hq/lk-jwt-service>.
4. Repo files: `dev:docs/plans/P1-foundation.md`, `dev:docker-compose.yml`, `dev:config/livekit.yaml`, `unit/b3:bots/soundboard/src/matrixrtc.js` and `livekit.js`.

Not verified (named for follow-up only, no claims depend on them): MSC3401, MSC4143, MSC4195 PRs; element-call repo; `config-sample.yaml`; the removed livekit#2581 reference (unrelated PR).
