# Squadz · Meshnet first-test runbook (no domain, no Cloudflare)

Zero to a voice call in a desktop browser in about 15 minutes. One Linux host with Docker, a NordVPN
account with Meshnet (Tailscale works the same), and one or two friends on desktop browsers.
For the real-domain setup (phones with Element X) see [DEPLOY.md](DEPLOY.md).

## How it works (and the honest limits)

- Caddy issues certificates from **its own local CA** (`SQUADZ_TLS=internal`). Nothing touches the
  internet. Every device must **trust that CA once** and **map two hostnames to the mesh IP**.
- Primary client for this test: the hosted web client (Cinny) at `https://chat.squadz.mesh/` in a
  desktop browser. Voice and screen share run in-browser.
- **Element X on Android will most likely refuse this server**: Android apps ignore user-installed CAs
  by default. Element X on iOS may work after installing and fully trusting the profile, but treat
  phones as best-effort. The fix for phones is a real domain with a public certificate (DEPLOY.md).
- Anyone who can reach the host over the mesh can reach it; the CA is public (no key leaves Caddy).

### Why hosts-file names, not Meshnet `<nickname>.nord` (decision)

| | A: hosts entries `chat.squadz.mesh` / `rtc.squadz.mesh` (chosen) | B: Meshnet `<peer>.nord` |
|---|---|---|
| Names per host | as many as we want, so chat and rtc stay two Caddy sites | one name per peer, so chat+rtc would need path routing or extra ports, a rewrite of the Caddyfile, well-known, LiveKit URLs and Cinny config |
| Stability | fixed by us | follows the peer nickname, which any user can rename (breaks the Matrix `server_name`, which cannot change after first start) |
| Works where | any OS that has a hosts file, no extra software | only on devices running the NordVPN client's Meshnet DNS; not on Tailscale; not reliable on mobile |
| Cost | one line per device, needs admin rights once | none |

Option A also behaves identically on Tailscale and keeps the stack's contract (two FQDNs) unchanged.
The names are overridable: `--chat-host` / `--rtc-host`. Mobile browsers cannot edit hosts files,
which is another reason phones are best-effort here.

## Quick start: `squadz init`

```bash
node scripts/squadz.mjs init --mesh-only --dry-run   # print the plan, run nothing
node scripts/squadz.mjs init --mesh-only             # setup > Caddy > CA export > stack > bootstrap > restart > doctor > first invite
```

It chains sections 2 to 5 below, passes `squadz-ca.crt` to bootstrap itself (no manual `NODE_EXTRA_CA_CERTS`),
and ends with the friend-onboarding summary (invite, hosts + CA steps per OS, the Cinny URL). It is
resumable: an existing `.env`, exported CA, running stack or bootstrapped server is detected and skipped.
It stops at the first failure and prints the exact command to run, then re-run `init` to continue.
Do the hosts-file entry (section 3) on this host before the doctor step. The manual steps below remain for reference.

## 1. Host prep (about 5 min)

```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker "$USER"   # re-login afterwards
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
# NordVPN: install, log in, turn Meshnet on, invite your friends' devices (Meshnet > Add device / Invite)
nordvpn set meshnet on
git clone <YOUR_REPO_URL> squadz && cd squadz
```

Friends install NordVPN, log in with their own account and accept your Meshnet invite (allow them
"Allow traffic routing: no", "Allow remote access: no"; they only need to reach this host).

## 2. Setup

```bash
node scripts/squadz.mjs setup --mesh-only
```

- Mesh IP is auto-detected: `nordvpn meshnet peer list` (the "Local Peer" block), then `tailscale ip -4`, then it asks.
- Flags: `--mesh-ip 100.x.y.z`, `--chat-host H`, `--rtc-host H` (two different hostnames), `--admin-user U`, `--force`.
- Writes `.env` with `SQUADZ_TLS=internal`, an empty `CLOUDFLARE_API_TOKEN` (not needed) and
  `COMPOSE_FILE=docker-compose.yml:docker-compose.mesh.yml`, so plain `docker compose` uses the mesh overlay.
- Copy the admin password it prints (once).

## 3. Hosts entry on the host and every device

Use the line setup printed, e.g. `100.101.102.103 chat.squadz.mesh rtc.squadz.mesh`.

| OS | File | How |
|---|---|---|
| Linux / macOS | `/etc/hosts` | `echo "<line>" \| sudo tee -a /etc/hosts` |
| Windows | `C:\Windows\System32\drivers\etc\hosts` | Notepad as Administrator, append the line |

## 4. Start Caddy, export and trust the CA

```bash
node scripts/validate.mjs
docker compose up -d --build --no-deps caddy   # first build compiles Caddy; ~2-4 min. --no-deps keeps lk-jwt-service down until the CA exists
node scripts/squadz.mjs ca export              # writes ./squadz-ca.crt, prints trust steps
docker compose up -d --build                   # now everything; lk-jwt-service mounts the CA
docker compose up -d --force-recreate --no-deps lk-jwt-service   # only if it ever ran with an empty CA
```

Trust `squadz-ca.crt` on every device (the command prints these):

- **Windows** (no admin needed): `certutil -user -addstore Root squadz-ca.crt`
- **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain squadz-ca.crt`
- **Linux**: `sudo cp squadz-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` (browsers: Chrome > Settings > Certificates > Authorities > Import; Firefox always needs its own import under Privacy & Security > Certificates)
- **iOS**: open the file, install the profile, then Settings > General > About > Certificate Trust Settings > enable full trust.
- **Android**: Settings > Security > Install a certificate > CA certificate (browsers only; Element X ignores it).

Restart the browser after trusting. Send `squadz-ca.crt` to friends over any channel: it is a public certificate.

## 5. Doctor, bootstrap, invite

```bash
export NODE_EXTRA_CA_CERTS="$PWD/squadz-ca.crt"    # so the Node scripts trust the CA
node scripts/squadz.mjs doctor
node scripts/bootstrap.mjs --env-file .env          # BEFORE anyone registers (first user = admin)
docker compose restart tuwunel
node scripts/squadz.mjs invite --name Sam
```

In mesh mode `doctor` skips the public DNS/ACME checks. It instead verifies that both hostnames
resolve to `MESH_IP` on this machine, that 443/7881 answer, and that the served certificates chain
to `squadz-ca.crt`, then runs the usual well-known, versions, lk-jwt and container checks.
The invite text still mentions Tailscale and Element X: tell friends to use NordVPN Meshnet, add the
hosts line, trust the CA, and open `https://chat.squadz.mesh/` in a desktop browser.

## 6. First voice call (browser)

1. Open `https://chat.squadz.mesh/`, register with the registration token from `invite`.
2. Open voice room **Lounge**, click the call button, allow microphone.
3. A friend does the same on their device. You should hear each other.
   Voice media is UDP 50000-50100 + TCP 7881 on the mesh IP; allow them in the host firewall
   (`sudo ufw allow in on nordlynx` or your mesh interface).

## lk-jwt-service and TLS (decision)

`lk-jwt-service` validates each user's Matrix OpenID token by calling `https://CHAT_FQDN`, which in
this mode is signed by Caddy's local CA. We **mount Caddy's public root cert** (`squadz-ca.crt`) into
the container as `SSL_CERT_FILE` (`docker-compose.mesh.yml`) and keep full verification on. The CI
overlay additionally sets `LIVEKIT_INSECURE_SKIP_VERIFY_TLS`; that is acceptable in a throwaway runner
but **not used here**, because skipping verification would let any mesh peer impersonate the
homeserver and mint LiveKit tokens. If you re-export the CA: `docker compose restart lk-jwt-service`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser warns "not private" | CA not trusted in that browser (Firefox has its own store); restart the browser |
| `doctor`: host does not resolve | add the hosts line on that machine |
| `doctor`: cert does not chain | re-run `ca export`; the CA changes only if the `caddy_data` volume was deleted, then every device must re-trust |
| Call connects but no audio | UDP 50000-50100 / TCP 7881 blocked by a firewall on the host |
| `lk-jwt-service` logs x509 errors | `squadz-ca.crt` empty when it started: `ca export`, then `docker compose restart lk-jwt-service` |
| Windows host: Docker not available | run the stack on a Linux host or WSL2; this repo's compose is Linux-first |
