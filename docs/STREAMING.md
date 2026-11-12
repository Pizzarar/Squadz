# High-FPS Game & Screen Streaming (`docs/STREAMING.md`)

Squadz includes a dedicated **Go-Live** web application served at `https://<CHAT_FQDN>/golive/` for 1080p60 and 1440p60 game/application streaming with stereo system audio over the LiveKit SFU (`https://<RTC_FQDN>`).

---

## 1. Element X & Element Call Screen-Share Limits Today

Element X (mobile) and Element Desktop/Web use **Element Call** (built on MatrixRTC / MSC3401 / MSC4143 and `livekit-client`) for group voice, video, and screen sharing. While Element Call works well for document sharing and casual desktop previews, it has several limitations for high-motion 60 FPS game streaming:

1. **Resolution & Frame Rate Ceiling**:
   - Out-of-the-box `livekit-client` screen-share presets (`ScreenSharePresets.h1080fps15` and `ScreenSharePresets.h1080fps30`) cap screen sharing at **1080p @ 15–30 FPS** with a conservative default bitrate (~1.5–3 Mbps).
   - Element Call does not expose a UI selector for **1080p60** or **1440p60**, nor does it allow overriding `maxBitrate` or `maxFramerate` per session.
2. **Degradation Preference**:
   - WebRTC and LiveKit default screen shares to `degradationPreference: "maintain-resolution"` (`contentHint: "detail"`). When encoding fast-moving 3D games, transient bitrate spikes cause WebRTC to drop frame rate down to 10–20 FPS to preserve static text sharpness. Game streaming requires `maintain-framerate` (or balanced mode) with a higher bitrate ceiling.
3. **Audio Processing & System-Audio Gaps**:
   - In Element Call (`element-hq/element-call`), screen share audio capture is either omitted by default (`setScreenShareEnabled(true)` without stereo music options) or routed through standard WebRTC voice constraints (`echoCancellation`, `noiseSuppression`, `autoGainControl`, mono 32–48 kbps Opus), which warps game soundtracks and spatial audio unless explicitly overridden (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, stereo 48 kHz Opus at 128–160 kbps).
   - On Element Desktop (Electron `desktopCapturer`), cross-platform system audio loopback has longstanding OS-level limitations compared to native Chromium `getDisplayMedia({ systemAudio: "include" })`.
4. **Element X Mobile Constraints**:
   - Element X (iOS/Android) embeds Element Call inside a mobile WebView (`ElementCallWidget`). While mobile clients can *view* high-FPS LiveKit screen shares published to a MatrixRTC call room via hardware-accelerated WebRTC decode, mobile WebViews do not support desktop `getDisplayMedia` with 60 FPS + stereo system audio publishing.

Because Element Call and the Go-Live page share the same LiveKit SFU and MatrixRTC signaling (`org.matrix.msc3401.call.member` + `lk-jwt-service`), a streamer can publish from `https://<CHAT_FQDN>/golive/` while friends watch either directly inside **Element Call** or via the Go-Live **Viewer Mode**.

---

## 2. LiveKit Codec, Simulcast/SVC, and Bitrate Settings (1080p60 & 1440p60)

### Codec Comparison for Game & Desktop Streaming

| Codec | Compression Efficiency | Scaling Mode in LiveKit | Hardware Encode Support | Best Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **VP9** (`video/vp9`) | High (~30–40% better than H.264) | **SVC** (`L3T3_KEY` or `L2T3_KEY`) | Intel QuickSync, modern AMD/NVIDIA, Chromium software/VAAPI | **Default choice** for 1080p60 / 1440p60 when viewers have varying bandwidth |
| **AV1** (`video/av1`) | Highest (~45–50% better than H.264) | **SVC** (`L3T3_KEY` / `L2T3_KEY`) | NVIDIA RTX 40-series+, AMD RX 7000+, Intel Arc | Best visual quality per megabit on modern GPUs |
| **H.264** (`video/h264`) | Baseline | **Simulcast** (separate independent encodes) | Universal (NVENC, AMF, QuickSync, Apple VideoToolbox) | Lowest encoder CPU/GPU overhead and universal hardware decode on older phones |

### Simulcast vs. SVC (Scalable Video Coding)

- **VP9 / AV1 with SVC**: When publishing VP9 or AV1, traditional multi-encode simulcast (`screenShareSimulcastLayers`) is not used. Instead, Chromium's WebRTC encoder produces a single bitstream containing spatial and temporal layers (e.g., `L3T3_KEY`). LiveKit's SFU can drop temporal frames (60 → 30 → 15 FPS) or spatial resolution for a constrained viewer without requiring the streamer's GPU to run multiple independent encoders.
- **H.264 without Simulcast (or 2-Layer Simulcast)**: With H.264, enabling 3-layer simulcast at 1440p60 forces the streamer's hardware encoder to run multiple simultaneous sessions, increasing GPU utilization and uplink bandwidth by ~35%. For a small 4-person mesh squad on fast residential connections, H.264 is best published as a single high-quality layer (or single 720p30 fallback layer) with `backupCodec: true`.

### Target Bitrate & Encoding Presets

The Go-Live page defines tested presets in `web/golive/lib/presets.mjs`:

| Preset ID | Resolution | FPS | Target Video Bitrate (VP9 / AV1) | Target Video Bitrate (H.264) | Audio Track (Opus Stereo) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `1080p60` | 1920 × 1080 | 60 | **6.0 Mbps** (`6_000_000` bps) | **8.0 Mbps** (`8_000_000` bps) | **160 kbps** (`160_000` bps), stereo, DTX off |
| `1440p60` | 2560 × 1440 | 60 | **10.0 Mbps** (`10_000_000` bps) | **14.0 Mbps** (`14_000_000` bps) | **160 kbps** (`160_000` bps), stereo, DTX off |
| `1080p30` | 1920 × 1080 | 30 | **3.5 Mbps** (`3_500_000` bps) | **4.5 Mbps** (`4_500_000` bps) | **128 kbps** (`128_000` bps), stereo, DTX off |

Key `livekit-client` publish options applied by Go-Live:
- `screenShareEncoding: { maxBitrate, maxFramerate, priority: 'high' }`
- `videoCodec`: selectable (`'vp9'`, `'av1'`, `'h264'`), defaulting to `'vp9'` with `backupCodec: true`
- `degradationPreference: 'maintain-framerate'` (configurable to `'balanced'` or `'maintain-resolution'` for text-heavy streams)
- Audio capture constraints: `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `channelCount: 2`, `sampleRate: 48000`

---

## 3. Browser System-Audio Capture Support

Web browsers capture screen and application audio via `navigator.mediaDevices.getDisplayMedia({ video: {...}, audio: {...}, systemAudio: "include", windowAudio: "system" })`. Support varies significantly by OS and browser engine:

| Platform & Browser | Entire Screen Audio (`systemAudio: "include"`) | Single Window Audio (`windowAudio`) | Browser Tab Audio | Recommended Action for Streamers |
| :--- | :--- | :--- | :--- | :--- |
| **Windows 10/11 — Chrome / Edge (105+)** | **Full support** (loopback via WASAPI) | Supported in recent Chromium builds (`windowAudio: "system"` / `"window"`) | Full support | **Recommended setup.** Select *Entire Screen* (or supported window) and check **"Also share system audio"**. |
| **macOS — Chrome / Edge** | Supported on macOS 13+ with Chrome 132+/141+ (CoreAudio tap); older versions Tab-only | Limited | Full support | Update Chrome/Edge and macOS, grant Screen & System Audio Recording permission in System Settings. |
| **Linux (PipeWire / Wayland / X11) — Chrome** | Tab-only by default (unless routed via PipeWire virtual sink) | Not supported | Full support | Use a PipeWire/PulseAudio monitor sink or share browser tabs. |
| **Firefox (All OSes)** | **Not supported** (`systemAudio` ignored) | **Not supported** | Limited | Use Chrome or Edge on Windows for Go-Live streaming with game audio. |
| **Safari (macOS)** | **Not supported** | **Not supported** | Limited | Use Chrome or Edge for publishing; Safari works for viewing. |

---

## 4. Upload Bandwidth Math: 1 Streamer to 3 Viewers over the Mesh

Squadz runs over an encrypted Layer-3 WireGuard-based mesh (**NordVPN Meshnet** or **Tailscale**). Every RTP media packet travels inside UDP/IP/WireGuard tunnels (typical mesh MTU is `1420` bytes, adding ~5–7% packetization + RTP/SRTP/WireGuard header overhead on top of raw media bitrate).

Let:
- $B_{\text{video}}$ = encoded video bitrate (`6.0 Mbps` for 1080p60 VP9; `10.0 Mbps` for 1440p60 VP9; `14.0 Mbps` for 1440p60 H.264)
- $B_{\text{audio}}$ = `0.16 Mbps` (160 kbps stereo Opus)
- $O_{\text{mesh}} \approx 1.07$ (7% overhead for RTP + SRTP + ICE + UDP + WireGuard headers + NACK/RTCP feedback)
- $B_{\text{stream}} = (B_{\text{video}} + B_{\text{audio}}) \times O_{\text{mesh}}$

Because **LiveKit is an SFU (Selective Forwarding Unit)** running on the Squadz host (`MESH_IP`), there are two deployment topologies to consider for **1 streamer and 3 viewers**:

### Case A: Streamer is a separate mesh peer (SFU runs on a dedicated Squadz host)
1. **Streamer Uplink**: The streamer sends **1 copy** of the stream to the LiveKit SFU on `MESH_IP`:
   $$\text{Streamer Upload} = 1 \times B_{\text{stream}}$$
2. **Squadz Host (SFU) Uplink**: The SFU forwards **3 copies** (1 per viewer) over the mesh:
   $$\text{SFU Host Upload} = 3 \times B_{\text{stream}}$$

### Case B: Streamer IS the Squadz host (self-hosting Docker on the gaming PC)
1. **Streamer Local Loopback to SFU**: `0 Mbps` WAN upload (browser → local LiveKit container on `MESH_IP`).
2. **Streamer/Host WAN Upload to 3 Viewers**: The host's LiveKit SFU sends **3 copies** over the mesh to the 3 friends:
   $$\text{Streamer/Host Upload} = 3 \times B_{\text{stream}}$$

### Bandwidth Summary Table (1 Streamer → 3 Viewers, including 7% Mesh/RTP Overhead)

| Preset & Codec | Raw Media ($B_{\text{video}} + B_{\text{audio}}$) | Single Stream w/ Overhead ($B_{\text{stream}}$) | Streamer Upload (Case A: Remote SFU) | SFU Host Upload to 3 Viewers (Case A & B) | Recommended Min. Upload Line (25% Headroom) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1080p60 VP9 / AV1** | 6.16 Mbps | **6.59 Mbps** | 6.6 Mbps | **19.8 Mbps** | **25 Mbps** (Host) / **10 Mbps** (Remote Streamer) |
| **1080p60 H.264** | 8.16 Mbps | **8.73 Mbps** | 8.7 Mbps | **26.2 Mbps** | **35 Mbps** (Host) / **12 Mbps** (Remote Streamer) |
| **1440p60 VP9 / AV1** | 10.16 Mbps | **10.87 Mbps** | 10.9 Mbps | **32.6 Mbps** | **42 Mbps** (Host) / **15 Mbps** (Remote Streamer) |
| **1440p60 H.264** | 14.16 Mbps | **15.15 Mbps** | 15.2 Mbps | **45.5 Mbps** | **58 Mbps** (Host) / **20 Mbps** (Remote Streamer) |

*Note*: If all 4 squad members also have simultaneous voice mics active (`~64 kbps` Opus each), add `~0.8 Mbps` total to the SFU host upload—negligible compared to the video stream.

---

## 5. Recommended `livekit.yaml` Changes

`config/livekit.yaml` is owned by Block B1 (Core stack). To ensure optimal 1080p60 and 1440p60 streaming without keyframe freezes or codec rejection, include the following settings in `config/livekit.yaml`:

```yaml
room:
  # Explicitly enable high-efficiency SVC codecs (VP9, AV1) alongside H.264/VP8,
  # and ALWAYS include video/rtx when specifying enabled_codecs so NACK packet
  # retransmissions work during 60fps keyframe bursts.
  enabled_codecs:
    - mime: audio/opus
    - mime: audio/red
    - mime: video/vp9
    - mime: video/av1
    - mime: video/h264
    - mime: video/vp8
    - mime: video/rtx

rtc:
  # Increase video packet buffer from default (500) to handle 1440p60 keyframe bursts
  # over WireGuard/Meshnet tunnels without dropping NACKed packets.
  packet_buffer_size_video: 1000
  packet_buffer_size_audio: 200
```

### Why these settings matter:
1. **`video/vp9` and `video/av1`**: Required for Scalable Video Coding (SVC) at 1080p60/1440p60, saving 30–45% mesh upload bandwidth compared to H.264.
2. **`video/rtx` caveat**: In LiveKit Server, whenever `room.enabled_codecs` is explicitly listed, omitting `video/rtx` disables WebRTC RTX retransmission packets, causing high-bitrate streams to freeze until the next keyframe whenever a single UDP packet drops on the mesh.
3. **`rtc.packet_buffer_size_video: 1000`**: At 14 Mbps (`1440p60`), a single second of video is ~1,300 RTP packets. A larger SFU ring buffer prevents out-of-order or retransmitted packets from ageing out before forwarding to the 3 viewers.

---

## 6. Go-Live Page Architecture (`web/golive/`)

The static web application in `web/golive/` runs directly from Caddy at `https://<CHAT_FQDN>/golive/` with zero build step required at serve time (`vendor/livekit-client.esm.mjs` is vendored in-repo).

### Contract Authentication Flow
1. **Matrix Login**: `POST https://<CHAT_FQDN>/_matrix/client/v3/login` (`m.login.password`) → returns `{ access_token, user_id, device_id }`.
2. **Room Alias Resolution**: If the user enters a room alias like `#Game Night:<CHAT_FQDN>` (or short name `Game Night`), resolves it via `GET /_matrix/client/v3/directory/room/{roomAlias}` to a canonical `!roomId:<CHAT_FQDN>`.
3. **OpenID Token Exchange**: `POST https://<CHAT_FQDN>/_matrix/client/v3/user/{userId}/openid/request_token` → returns `{ access_token, token_type, matrix_server_name, expires_in }`.
4. **LiveKit SFU Token**: `POST https://<RTC_FQDN>/livekit/jwt/sfu/get` with `{ room, openid_token, device_id }` → returns `{ url, jwt }`.
5. **MatrixRTC Call Member State (`org.matrix.msc3401.call.member`)**: Optionally publishes the participant's MatrixRTC state event to the room so native **Element Call** clients in the same room reconcile the LiveKit participant and display the stream tile automatically, and clears it on disconnect.

---

## 7. Sources & References

1. **LiveKit Client SDK — Screen Sharing, Codecs & Simulcast/SVC**:
   - LiveKit Documentation, *Camera & Microphone / Screen Sharing & Simulcast*: <https://docs.livekit.io/home/client/tracks/publish/>
   - LiveKit JS Client SDK (`VideoPresets`, `ScreenSharePresets`, `TrackPublishOptions`, `ScalabilityMode`): <https://github.com/livekit/client-sdk-js>
2. **LiveKit Server Configuration (`livekit.yaml` & `video/rtx`)**:
   - LiveKit Server Sample Config (`config-sample.yaml`): <https://github.com/livekit/livekit/blob/master/config-sample.yaml>
   - LiveKit Issue #2581 — `enabled_codecs` requires `video/rtx` for NACK recovery: <https://github.com/livekit/livekit/issues/2581>
3. **MatrixRTC & Element Call Architecture**:
   - MSC4143 (MatrixRTC LiveKit Foci & `org.matrix.msc4143.rtc_foci`): <https://github.com/matrix-org/matrix-spec-proposals/pull/4143>
   - MSC3401 (Native Group VoIP Signaling / `org.matrix.msc3401.call.member`): <https://github.com/matrix-org/matrix-spec-proposals/pull/3401>
   - Element HQ `lk-jwt-service` (`/sfu/get` OpenID exchange): <https://github.com/element-hq/lk-jwt-service>
   - Element Call Repository: <https://github.com/element-hq/element-call>
4. **Browser `getDisplayMedia` & System Audio Constraints**:
   - MDN Web Docs — `MediaDevices.getDisplayMedia()` (`systemAudio`, `windowAudio`): <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia>
   - W3C Screen Capture Specification: <https://w3c.github.io/mediacapture-screen-share/>
