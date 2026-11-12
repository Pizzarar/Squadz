# Squadz Soundboard Bot (`bots/soundboard`)

Plays short audio clips (`.mp3`, `.ogg`, `.wav`) from `/clips` into active MatrixRTC (LiveKit) voice rooms when triggered by chat commands.

## Commands

Send in any Matrix room the bot is invited to:

- `!sb` or `!sb list` — list available clip names from `/clips`
- `!sb play <clip>` — join the room's active MatrixRTC call (if one is ongoing), decode `<clip>` to 48 kHz mono PCM via `ffmpeg`, publish it to LiveKit, and leave after the idle timeout
- `!sb stop` — stop the currently playing clip immediately

The bot **only joins a LiveKit call when `!sb play <clip>` is run and at least one human participant has an active MatrixRTC membership in the room**. When the idle timeout expires (default `60s`) or the bot shuts down, it disconnects from LiveKit and posts an empty `{}` state event to remove its `org.matrix.msc3401.call.member` state.

## Environment Variables (Contract)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CHAT_FQDN` | Yes | — | Matrix homeserver domain (e.g. `chat.example.com`) |
| `RTC_FQDN` | Yes | — | MatrixRTC / LiveKit domain (e.g. `rtc.example.com`) |
| `SOUNDBOARD_MATRIX_USER` | Yes | — | Bot Matrix username or MXID |
| `SOUNDBOARD_MATRIX_PASSWORD` | Yes | — | Bot Matrix password |
| `SOUNDBOARD_CLIPS_DIR` | No | `/clips` | Directory mounted with `.mp3` / `.ogg` / `.wav` clips |
| `SOUNDBOARD_IDLE_TIMEOUT_MS` | No | `60000` | Idle time in ms before leaving a call and clearing state |

## Architecture & Protocol Isolation

- [`src/matrixrtc.js`](./src/matrixrtc.js) — **Isolated MatrixRTC protocol layer** (MSC4143 / MSC3401 / MSC4195) and `lk-jwt-service` token exchange (`POST https://${RTC_FQDN}/livekit/jwt/sfu/get`). Supports reading both modern per-device session state events (`state_key: _<user>_<device>_m.call`) and legacy `memberships: [...]` arrays, and writes per-device MSC4143 membership state with `focus_active` (`oldest_membership`) and `foci_preferred`.
- [`src/matrix.js`](./src/matrix.js) — Minimal `fetch`-based Matrix Client-Server v3 wrapper (`/login`, `/user/{id}/openid/request_token`, `/sync`, `/join`, `/state`, `/send`).
- [`src/audio.js`](./src/audio.js) — Spawns `ffmpeg` (`-f s16le -acodec pcm_s16le -ar 48000 -ac 1 pipe:1`) and slices raw PCM into 20 ms (`960`-sample `Int16Array`) frames.
- [`src/livekit.js`](./src/livekit.js) — Wraps `@livekit/rtc-node` (`Room`, `AudioSource`, `LocalAudioTrack`, `AudioFrame`) with playback preemption and idle auto-disconnect.
- [`src/clips.js`](./src/clips.js) & [`src/commands.js`](./src/commands.js) — Clip directory scanner and `!sb` command parser.
- [`clips/beep.wav`](./clips/beep.wav) — Self-generated 0.4 s 880 Hz sine wave test clip (regenerated via `npm run gen-beep`).

## Protocol & SDK Sources

1. **MSC4143 (MatrixRTC — Real-time communication over Matrix)** — Defines the MatrixRTC session framework, `focus_active` (`type: "livekit"`, `focus_selection: "oldest_membership"`), and `foci_preferred` discovery (`https://github.com/matrix-org/matrix-spec-proposals/pull/4143`).
2. **MSC3401 (Native Group VoIP Signalling)** — Defines the `org.matrix.msc3401.call.member` state event, `application: "m.call"`, `scope: "m.room"`, `expires`, and clearing membership via `{}` (`https://github.com/matrix-org/matrix-spec-proposals/pull/3401`).
3. **MSC4195 & `matrix-js-sdk` (`src/matrixrtc/CallMembership.ts`)** — Reference implementation used by Element Call and Element X for per-device state keys (`_<userId>_<deviceId>_m.call`) and LiveKit focus metadata (`livekit_service_url`, `livekit_alias`) (`https://github.com/matrix-org/matrix-js-sdk/tree/develop/src/matrixrtc`).
4. **Element `lk-jwt-service`** — Matrix OpenID token exchange endpoint `POST /sfu/get` accepting `{ room, openid_token, device_id }` and returning `{ url, jwt }` (`https://github.com/element-hq/lk-jwt-service`).
5. **LiveKit Node.js Realtime SDK (`@livekit/rtc-node`)** — `Room`, `AudioSource(sampleRate, channels)`, `LocalAudioTrack.createAudioTrack(name, source)`, `AudioFrame(data, sampleRate, channels, samplesPerChannel)`, `captureFrame`, `waitForPlayout`, and `clearQueue` (`https://docs.livekit.io/reference/client-sdk-node/` and `https://github.com/livekit/node-sdks`).

## Testing

Tests mock `fetch`, `ffmpeg` (`child_process.spawn`), and `@livekit/rtc-node`, so they run cleanly without Docker, `ffmpeg`, or a live server:

```sh
cd bots/soundboard && npm test
```
