# Credits

Squadz is glue around these open-source projects. Nothing here is copied code unless noted.

## Stack
- Implemented the homeserver — Thanks to Tuwunel by the matrix-construct community
- Implemented voice/video SFU — Thanks to LiveKit server by LiveKit
- Implemented MatrixRTC auth (`/sfu/get`) — Thanks to lk-jwt-service by element-hq
- Implemented TLS termination with DNS-01 — Thanks to Caddy by the Caddy project and caddy-dns/cloudflare by the caddy-dns community
- Clients — Thanks to Element X and Element Call by element-hq

## Features
- Implemented hosted web client (Cinny served from Caddy, locked config.json, Element Call iframe headers) — Thanks to Cinny by cinnyapp
- Implemented emoji/sticker CLI (MSC2545 usage) — Thanks to MSC2545 by the Matrix.org community
- Implemented custom emoji packs (MSC2545 `im.ponies.room_emotes`) — Thanks to MSC2545 by the Matrix.org community
- Implemented call rooms and `call.member` events (MSC3401/MSC4143/MSC4196) — Thanks to MatrixRTC by the Matrix.org community
- Implemented soundboard bot session handling (protocol checked, no code copied) — Thanks to matrix-js-sdk by matrix-org, lk-jwt-service by element-hq and node-sdks by LiveKit
- Implemented screen-share presets, publish options and audio presets reference — Thanks to client-sdk-js by LiveKit
- Implemented Go-Live screen-share publish (vendored livekit-client 2.23.0, unmodified, Apache-2.0) — Thanks to livekit-client (client-sdk-js) by LiveKit
- Implemented `getDisplayMedia` hint notes — Thanks to MDN Web Docs by Mozilla contributors
- Implemented real-stack e2e CI (internal-TLS overlay, LiveKit twirp/signalling checks, LIVEKIT_INSECURE_SKIP_VERIFY_TLS test switch) — Thanks to Caddy by the Caddy authors (Matthew Holt et al.), lk-jwt-service by element-hq and livekit/protocol by LiveKit
- Implemented `squadz server` settings + pinned welcome (name/icon/topics, markdown notice) — Thanks to Discord (server settings and welcome screen, design inspiration only, no code borrowed) by Discord Inc.
- Implemented phone-notification push path (Element X pusher -> matrix.org Sygnal gateway), doctor check and mock-gateway e2e — Thanks to Tuwunel by the matrix-construct contributors (Jason Volk et al.), Element X iOS/Android by Element (element-hq) and Sygnal by Matrix.org Foundation / Element
- Implemented mesh-only mode (`setup --mesh-only`, `ca export`, hosts-file DNS, internal-TLS doctor, CA-trusting lk-jwt-service overlay) — Thanks to Caddy (local CA / `tls internal`, PKI paths) by the Caddy authors (Matthew Holt et al.), lk-jwt-service by element-hq and NordVPN Meshnet / Tailscale CGNAT addressing by Nord Security / Tailscale Inc.
- Implemented Squadz Cinny branding (title/manifest/favicon injection, Folds colour-variable theme override in squadz.css) — Thanks to Cinny by cinnyapp (Ajay Bura and contributors)
- Implemented Squadz logo, wordmark and Go-Live restyle — original artwork; PNG export — Thanks to resvg-js by yisibl
