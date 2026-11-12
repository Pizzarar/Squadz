# Squadz

*Where squadz meet* — self-hosted private Matrix chat (**Tuwunel**) + MatrixRTC voice, video, soundboard, and high-FPS game streaming (**LiveKit** + **lk-jwt-service**), reachable exclusively over an L3 mesh (**NordVPN Meshnet** or **Tailscale**) with real-domain TLS via **Caddy** ACME DNS-01.

## Features

- **Zero Public Ports**: Every published port (`443/tcp`, `443/udp`, `7881/tcp`, `50000-50100/udp`) binds strictly to your mesh IP (`MESH_IP`, `100.x.y.z`).
- **Real-Domain TLS Without Inbound HTTP**: Caddy terminates TLS for `CHAT_FQDN` and `RTC_FQDN` using Let's Encrypt DNS-01 challenges (`caddy-dns/cloudflare`).
- **Native Matrix + MatrixRTC**: Works out of the box with **Element X** (iOS/Android) and **Element Desktop** via `.well-known/matrix/client` (`org.matrix.msc4143.rtc_foci`).
- **Idempotent Space & Emoji Seeding**: `scripts/bootstrap.mjs` creates the `Squadz` Space, text rooms (`#general`, `#games`, `#clips`, `#memes`), voice rooms (`Lounge`, `Game Night`), and custom emoji pack.
- **Soundboard Bot & Go-Live Streaming**: Optional MatrixRTC soundboard bot (`bots/soundboard`) and 1080p60/1440p60 browser screen-share publisher (`web/golive`).

## Quick Start

```bash
# 1. Configure environment variables
cp .env.example .env
# Edit .env with your SQUADZ_DOMAIN, MESH_IP, CLOUDFLARE_API_TOKEN, and generated secrets

# 2. Run static validation (Node 20+, zero dependencies)
node scripts/validate.mjs

# 3. Boot the stack
docker compose up -d

# 4. Seed the Squadz Space, channels, voice rooms, and emoji pack
node scripts/bootstrap.mjs
```

## Repository Layout

- [`docker-compose.yml`](docker-compose.yml), [`.env.example`](.env.example): Full container stack and environment contract.
- [`caddy/`](caddy/): Custom Caddy 2.9.1 Dockerfile (with `caddy-dns/cloudflare`) and `Caddyfile`.
- [`config/`](config/): [`tuwunel.toml`](config/tuwunel.toml) (Matrix homeserver) and [`livekit.yaml`](config/livekit.yaml) (LiveKit SFU).
- [`scripts/`](scripts/): Static validator ([`scripts/validate.mjs`](scripts/validate.mjs)) and Space bootstrapper (`scripts/bootstrap.mjs`).
- [`bots/soundboard/`](bots/): MatrixRTC soundboard bot (`--profile bots`).
- [`web/golive/`](web/): Static high-FPS screen-share web app served at `https://<CHAT_FQDN>/golive/`.
- [`docs/`](docs/):
  - [`docs/SETUP.md`](docs/SETUP.md) — Host, mesh, Cloudflare DNS-01, first boot, and troubleshooting guide.
  - `docs/ONBOARDING.md` — Friend guide for Element X and Element Desktop.
  - `docs/STREAMING.md` — High-FPS streaming codec, bitrate, and bandwidth guide.
