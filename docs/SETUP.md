# Squadz · Host & Mesh Setup Guide

> **Deploying for the first time?** Follow the step-by-step runbook in [DEPLOY.md](DEPLOY.md) (it drives everything through `node scripts/squadz.mjs`). This page is the reference: architecture, mesh options, DNS and troubleshooting.

Self-hosted private Matrix chat (**Tuwunel**) + MatrixRTC voice/video (**LiveKit** + **lk-jwt-service**) behind **Caddy** with real-domain TLS via ACME DNS-01. All traffic binds exclusively to your L3 mesh IP (`<MESH_IP>`)—zero ports are exposed to the public internet.

---

## 1. Architecture Overview

| Service | Image / Build | Internal Port | Mesh-Published Port | Role |
|---|---|---|---|---|
| `caddy` | `./caddy` (`caddy:2.9.1-alpine` + `caddy-dns/cloudflare`) | `443/tcp`, `443/udp` | `<MESH_IP>:443/tcp`, `<MESH_IP>:443/udp` | ACME DNS-01 TLS termination, `.well-known` discovery, reverse proxy, `/golive/*` static host |
| `tuwunel` | `ghcr.io/matrix-construct/tuwunel:v1.5.1` | `6167/tcp` | *(internal only)* | Rust Matrix homeserver (RocksDB backend, federation disabled, token registration) |
| `livekit` | `livekit/livekit-server:v1.9.12` | `7880/tcp` (WS) | `<MESH_IP>:7881/tcp`, `<MESH_IP>:50000-50100/udp` | MatrixRTC WebRTC SFU (`node_ip: <MESH_IP>`, no STUN/TURN needed on mesh) |
| `lk-jwt-service` | `ghcr.io/element-hq/lk-jwt-service:0.4.4` | `8080/tcp` | *(internal only)* | Exchanges Matrix OpenID tokens for LiveKit room JWTs (MSC4143) |
| `soundboard` | `./bots/soundboard` (`--profile bots`) | — | *(internal only)* | Optional MatrixRTC soundboard bot (`!sb list`, `!sb play`, `!sb stop`) |

### Hostnames & Routing
Two subdomains under `<SQUADZ_DOMAIN>` point to `<MESH_IP>`:
- **`https://<CHAT_FQDN>`** (default `chat.<SQUADZ_DOMAIN>`):
  - `/.well-known/matrix/client` → Matrix homeserver base URL + `org.matrix.msc4143.rtc_foci` pointing to `https://<RTC_FQDN>/livekit/jwt`
  - `/_matrix/*` → `tuwunel:6167`
  - `/golive/*` → Static files from `web/golive/`
- **`https://<RTC_FQDN>`** (default `rtc.<SQUADZ_DOMAIN>`):
  - `/livekit/jwt/*` → `lk-jwt-service:8080` (prefix stripped)
  - `/livekit/sfu/*` → `livekit:7880` (prefix stripped, WebSocket signaling)

---

## 2. L3 Mesh Setup (Tailscale default, NordVPN Meshnet alternative)

Every participant (and the Docker host) joins a shared L3 mesh network assigning CGNAT `100.x.y.z` IPv4 addresses.

### Option A: Tailscale (default)
1. Install Tailscale on the host and authenticate:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Retrieve the host's Tailscale IPv4 address (`100.x.y.z`):
   ```bash
   tailscale ip -4
   ```
3. Invite friends into your tailnet (Users > Invite external users) or share the host machine with them (Machines > Share). The free plan covers 3 users.

### Option B: NordVPN Meshnet (alternative)
1. Install the NordVPN Linux client on the host and log in:
   ```bash
   sh <(curl -sSf https://downloads.nordcdn.com/apps/linux/install.sh)
   nordvpn login
   nordvpn set meshnet on
   ```
2. Find the host's Meshnet IP (`100.64.0.0/10` range):
   ```bash
   nordvpn meshnet peer list
   ```
3. Invite your squad friends' NordVPN accounts and grant incoming traffic permissions:
   ```bash
   nordvpn meshnet peer incoming allow <PEER_HOSTNAME_OR_IP>
   ```

Record this `100.x.y.z` address—it is your `MESH_IP` in `.env`. `node scripts/squadz.mjs setup` detects it for you (`tailscale ip -4`, then `nordvpn meshnet peer list`).

---

## 3. Domain, Cloudflare API Token & DNS Records

Because `MESH_IP` is a private CGNAT address (`100.64.0.0/10`), Let's Encrypt HTTP-01 challenges cannot reach the host from the public internet. Instead, Caddy uses **ACME DNS-01** to prove domain ownership via TXT records, while public `A` records point directly to `<MESH_IP>`. Only peers on your mesh can route to `<MESH_IP>`.

### 3.1 Create DNS `A` Records
In your Cloudflare DNS dashboard for `<SQUADZ_DOMAIN>`, create two **DNS-only** (grey cloud / unproxied) `A` records:

| Type | Name | Content (IPv4) | Proxy Status | TTL |
|---|---|---|---|---|
| `A` | `chat` (`<CHAT_FQDN>`) | `<MESH_IP>` (e.g. `100.64.0.1`) | **DNS only** (grey cloud) | Auto |
| `A` | `rtc` (`<RTC_FQDN>`) | `<MESH_IP>` (e.g. `100.64.0.1`) | **DNS only** (grey cloud) | Auto |

### 3.2 Create a Scoped Cloudflare API Token
1. Open [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token**.
2. Choose the **Edit zone DNS** template:
   - **Permissions**: `Zone` → `DNS` → `Edit`
   - **Zone Resources**: `Include` → `Specific zone` → `<SQUADZ_DOMAIN>`
3. Copy the generated token into `CLOUDFLARE_API_TOKEN` in `.env`.

> **Swapping DNS Providers**: `caddy/Dockerfile` accepts `--build-arg DNS_PROVIDER=github.com/caddy-dns/<provider>` if your domain uses another provider supported by [caddy-dns](https://github.com/caddy-dns). Update the `tls { dns <provider> ... }` block in `caddy/Caddyfile` to match.

---

## 4. Environment Configuration & First Boot

### 4.1 Generate `.env`
The easy way: `node scripts/squadz.mjs setup` (prompts for domain, Cloudflare token and mesh IP, generates every secret, writes `.env` mode 600, refuses to overwrite without `--force`). Manual alternative: copy the template and generate random secrets:

```bash
cp .env.example .env
```

Generate keys for `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `TUWUNEL_REGISTRATION_TOKEN`:
```bash
echo "LIVEKIT_API_KEY=lk_$(openssl rand -hex 6)"
echo "LIVEKIT_API_SECRET=$(openssl rand -base64 32)"
echo "TUWUNEL_REGISTRATION_TOKEN=$(openssl rand -base64 24)"
```

Fill in `.env` with your real values:
- `SQUADZ_DOMAIN=<YOUR_DOMAIN>`
- `CHAT_FQDN=chat.<YOUR_DOMAIN>`
- `RTC_FQDN=rtc.<YOUR_DOMAIN>`
- `MESH_IP=<YOUR_100.X.Y.Z_MESH_IP>`
- `ACME_EMAIL=<YOUR_EMAIL>`
- `CLOUDFLARE_API_TOKEN=<YOUR_CF_TOKEN>`
- `SQUADZ_ADMIN_USER=<ADMIN_USERNAME>`
- `SQUADZ_ADMIN_PASSWORD=<ADMIN_PASSWORD>`
- `SOUNDBOARD_MATRIX_USER=soundboard`
- `SOUNDBOARD_MATRIX_PASSWORD=<BOT_PASSWORD>`

### 4.2 Validate Statically and Run Doctor
Before booting, run the zero-dependency static validator (requires Node 20+):
```bash
node scripts/validate.mjs
```
Once the stack is up, `node scripts/squadz.mjs doctor` checks DNS, ports, TLS, discovery, the Matrix API, lk-jwt and the containers, printing a fix for every failure.

### 4.3 Start the Core Stack & Seed the Space
1. Ensure your mesh interface (`nordlynx` or `tailscale0`) is up and owns `<MESH_IP>`.
2. Start the stack:
   ```bash
   docker compose up -d
   ```
3. Watch Caddy acquire Let's Encrypt certificates for `<CHAT_FQDN>` and `<RTC_FQDN>` via DNS-01:
   ```bash
   docker compose logs -f caddy
   ```
4. Verify discovery and Matrix API over the mesh:
   ```bash
   curl -fsSL https://<CHAT_FQDN>/.well-known/matrix/client
   curl -fsSL https://<CHAT_FQDN>/_matrix/client/versions
   ```
5. Seed the admin account, "Squadz" Space, channels (`#general`, `#games`, `#clips`, `#memes`), voice rooms (`Lounge`, `Game Night`), and custom emoji pack (Block B2):
   ```bash
   node scripts/bootstrap.mjs
   ```
   Run this before friends register: the first registered user becomes the Tuwunel admin. Then `docker compose restart tuwunel` so `auto_join_rooms` (new accounts join the Space and rooms automatically) sees the rooms.
6. *(Optional)* Start the soundboard bot container once its account and clips are ready (Block B3):
   ```bash
   docker compose --profile bots up -d soundboard
   ```

---

## 5. Troubleshooting

### 5.1 DNS Rebinding Protection on Home Routers
Because `chat.<SQUADZ_DOMAIN>` and `rtc.<SQUADZ_DOMAIN>` resolve to `100.64.0.0/10` (RFC 6598 CGNAT space), routers running `dnsmasq`, pfSense, OPNsense, OpenWrt, or Fritz!Box with **DNS Rebinding Protection** enabled may drop DNS replies in the `100.64.0.0/10` range.

**Symptoms**: `nslookup chat.<SQUADZ_DOMAIN> 1.1.1.1` returns `<MESH_IP>`, but `nslookup chat.<SQUADZ_DOMAIN>` against your LAN router returns empty/`NXDOMAIN`/`REFUSED`.

**Fixes**:
- **Router Whitelist**: Add `<SQUADZ_DOMAIN>` to your router's DNS rebind domain allowlist (e.g., `rebind-domain-ok=/<SQUADZ_DOMAIN>/` in `dnsmasq` / OpenWrt, or *System → Advanced → Admin Access → Alternate Hostnames / DNS Rebind Check* in pfSense/OPNsense).
- **Client Encrypted DNS (DoH/DoT)**: Configure clients or OS resolvers to use Cloudflare (`1.1.1.1`) or Quad9 (`9.9.9.9`) directly.

### 5.2 Windows / WSL2 & Docker Desktop UDP Caveats
Running the stack on a native Linux host is strongly recommended. If hosting on **Windows with WSL2 / Docker Desktop**, keep these caveats in mind:
1. **Mesh IP Binding Inside WSL2**: If NordVPN or Tailscale runs on the Windows host rather than inside the WSL2 utility VM, Docker inside Linux may not see the Windows `100.x.y.z` adapter directly when binding `${MESH_IP}:50000-50100/udp`. Run `tailscale` (or `nordvpn`) natively inside the WSL2 distro, or enable **WSL2 Mirrored Mode Networking** (`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig` on Windows 11 23H2+).
2. **UDP Port Range Forwarding (50000–50100/udp)**: Docker Desktop's userland proxy incurs overhead when forwarding 101 UDP ports (`50000-50100/udp`) and may drop high-bitrate WebRTC packets during 1080p60/1440p60 screen shares. If WebRTC media fails to connect over UDP and falls back to TCP (`7881/tcp`), verify that Windows Firewall permits inbound UDP `50000-50100` and TCP `443, 7881` on the mesh interface (`NordLynx` / `Tailscale`).

### 5.3 Container Internal Loopback (`lk-jwt-service` → `tuwunel`)
When a user joins a call, `lk-jwt-service` verifies their Matrix OpenID token by connecting to `https://<CHAT_FQDN>/_matrix/federation/v1/openid/userinfo`. Because `docker-compose.yml` adds `extra_hosts` mapping `${CHAT_FQDN}` and `${RTC_FQDN}` to `${MESH_IP}`, containers inside Docker reach Caddy on `<MESH_IP>:443` without hair-pinning through an external router. Ensure your host firewall (`ufw` / `nftables`) allows traffic from the `docker0` / `br-*` bridge subnets to `<MESH_IP>:443/tcp`.

---

## 6. Upstream References & Version Citations

- **Tuwunel** (`ghcr.io/matrix-construct/tuwunel:v1.5.1`):
  - Repository & Releases: <https://github.com/matrix-construct/tuwunel/releases>
  - Configuration (`tuwunel.toml`, `[global.well_known]`, `TUWUNEL_*` env overrides): <https://github.com/matrix-construct/tuwunel>
- **LiveKit Server** (`livekit/livekit-server:v1.9.12`):
  - Repository & Releases: <https://github.com/livekit/livekit/releases>
  - Self-hosting & Configuration (`rtc.node_ip`, `use_external_ip`, `port_range_start`/`end`, `tcp_port`, `LIVEKIT_KEYS`): <https://docs.livekit.io/home/self-hosting/deployment/>
- **MatrixRTC LiveKit JWT Service** (`ghcr.io/element-hq/lk-jwt-service:0.4.4`):
  - Repository & Releases: <https://github.com/element-hq/lk-jwt-service/releases>
  - Environment variables (`LIVEKIT_URL`, `LIVEKIT_KEY`, `LIVEKIT_SECRET`, `LIVEKIT_FULL_ACCESS_HOMESERVERS`, `LIVEKIT_JWT_BIND`): <https://github.com/element-hq/lk-jwt-service#readme>
- **Caddy & Cloudflare DNS-01 Plugin** (`caddy:2.9.1-alpine` + `github.com/caddy-dns/cloudflare`):
  - Caddy Releases: <https://github.com/caddyserver/caddy/releases>
  - Cloudflare DNS module for Caddy: <https://github.com/caddy-dns/cloudflare>
