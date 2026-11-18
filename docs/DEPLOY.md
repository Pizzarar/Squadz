# Squadz · Deploy runbook (zero to running)

Written for Aub: an Ubuntu box, a Tailscale account, a domain on Cloudflare. About 30 minutes.

> Just testing over NordVPN Meshnet, no domain? Use [DEPLOY-MESHNET.md](DEPLOY-MESHNET.md) (`squadz setup --mesh-only`) instead of this runbook.
Everything operational goes through one tool: `node scripts/squadz.mjs <setup|doctor|invite|role|sync-members|backup|restore|service|update>`
(`node scripts/squadz.mjs --help`). Background and troubleshooting live in [SETUP.md](SETUP.md).

> **Fastest path:** `node scripts/squadz.mjs init` chains sections 3 to 7 (setup, up, bootstrap, restart, doctor, first invite),
> skips whatever is already done, and stops with the exact next command on failure. `--dry-run` prints the plan; for the
> no-domain Meshnet first test use `init --mesh-only` ([DEPLOY-MESHNET.md](DEPLOY-MESHNET.md)). Do sections 1 and 2 (host prep, DNS) first.

## 0. What you need

| Thing | Notes |
|---|---|
| Linux host | Ubuntu 24.04 LTS reference. Docker Engine + the compose plugin, Node 20+, git. Windows only via WSL2 mirrored networking ([SETUP.md §5.2](SETUP.md)); not recommended. |
| Tailscale account | Free plan covers 3 users. Default mesh. NordVPN Meshnet also works ([SETUP.md §2](SETUP.md)). |
| A domain on Cloudflare | Any domain whose DNS Cloudflare serves. |
| Cloudflare API token | Permission `Zone > DNS > Edit`, scoped to that one zone ([SETUP.md §3.2](SETUP.md)). |

## 1. Host prep

```bash
# Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker "$USER"   # log out/in afterwards
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
# Tailscale: join the tailnet and note the host's 100.x address
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
tailscale ip -4
git clone <YOUR_REPO_URL> squadz && cd squadz
```

## 2. DNS

In Cloudflare, add two **DNS only** (grey cloud) A records, both pointing at the Tailscale IP from step 1:

| Name | Content |
|---|---|
| `chat.<DOMAIN>` | `<MESH_IP>` |
| `rtc.<DOMAIN>` | `<MESH_IP>` |

Only tailnet members can route to a `100.x` address, so nothing is exposed publicly. Certificates come from ACME DNS-01 via the token.

## 3. `squadz setup`

```bash
node scripts/squadz.mjs setup
```

It asks for the domain, the Cloudflare token and the mesh IP (auto-detected with `tailscale ip -4`, falling back to `nordvpn meshnet peer list`, then manual entry). It generates the LiveKit key and secret, the registration token and the bot and admin passwords, and writes `.env` (mode 600, gitignored). It prints only the admin password, once: copy it. It will not overwrite an existing `.env` unless you pass `--force` (which generates **new** secrets).

Non-interactive: `node scripts/squadz.mjs setup --domain example.com --cloudflare-token <TOKEN> --mesh-ip <MESH_IP> --yes`.

## 4. Start the stack

```bash
node scripts/validate.mjs        # static checks, expect all checks to pass
docker compose up -d --build     # first build compiles Caddy with the Cloudflare plugin
docker compose logs -f caddy     # wait for "certificate obtained successfully" x2, then Ctrl-C
```

## 5. `squadz doctor`

```bash
node scripts/squadz.mjs doctor
```

Checks that both A records resolve to `MESH_IP`, 443 and 7881 accept TCP, both TLS certs are valid, `/.well-known/matrix/client` has the right homeserver and `rtc_foci`, `/_matrix/client/versions` answers, the lk-jwt-service `/healthz` answers, and all four containers are running. Each line is `OK` or `FAIL` with the fix underneath. Fix everything before continuing. Doctor cannot probe UDP 50000-50100; the on-device call test below covers it.

## 6. Bootstrap (create the Space) **before anyone else registers**

```bash
node scripts/bootstrap.mjs --env-file .env
```

This registers your admin account from `.env` and creates the Space "Squadz" with `#general #games #clips #memes` and the voice rooms `Lounge` and `Game Night`, plus the emoji pack. It must run before any friend signs up: Tuwunel makes the **first registered user the server admin** (`grant_admin_to_first_user`), and the admin room is what `squadz invite` uses to issue tokens.

Then restart once so Tuwunel's auto-join sees the now-existing rooms (it only auto-joins rooms the server already knows):

```bash
docker compose restart tuwunel
```

## 7. Invite two friends

```bash
node scripts/squadz.mjs invite --name Sam --mesh-invite <TAILSCALE_INVITE_LINK>
node scripts/squadz.mjs invite --name Alex --mesh-invite <TAILSCALE_INVITE_LINK>
```

Each prints a pasteable message (join the tailnet, install Element X / Element, server `chat.<DOMAIN>`, a registration token, what they will see). Invite messages also link the hosted web client (Cinny) at `https://chat.<DOMAIN>/`; pass `--no-web` to omit it. Friends **pick their own usernames**. Tokens are **single-use** (`!admin token issue --once`, Tuwunel `src/admin/token`): once one friend registers with it, it is dead. If the admin room does not answer, `invite` says so and falls back to the shared `TUWUNEL_REGISTRATION_TOKEN`; use `--shared` to force that. Rotate the shared token in `.env` afterwards.

Create the Tailscale invite link in the Tailscale admin console (Users > Invite external users), or share the host machine with them (Machines > Share).

New accounts auto-join the Space and its rooms (`auto_join_rooms`, wired in `config/tuwunel.toml` and `TUWUNEL_AUTO_JOIN_ROOMS` in `docker-compose.yml`). If someone did not land in the Space, run `node scripts/squadz.mjs sync-members` to invite every local user to it.

Roles (Discord-style power levels across the Space and every room; safe to re-run):

```bash
node scripts/squadz.mjs role sam mod      # owner = 100, mod = 50, member = 0
```

## 8. Element X phone checklist (you, on your own phone first)

- [ ] Tailscale app installed, signed in, connected (VPN toggle on).
- [ ] Element X installed. **Create account** > change account provider > `chat.<DOMAIN>`.
- [ ] Username and password chosen, registration token pasted, account created (no certificate warning).
- [ ] You land in the **Squadz** Space with all six rooms listed.
- [ ] Recovery key saved.
- [ ] `#general` message sends and arrives on a second device.
- [ ] Open **Lounge**, tap the call button: mic works, your friend hears you.
- [ ] Turn Wi-Fi off, stay on mobile data with Tailscale on: still connects.

## 8b. Web client check (Cinny at `https://chat.<DOMAIN>/`)

The Caddy image bundles Cinny v4.12.8 (pinned tarball, sha256-verified at build) and renders
its `config.json` from `CHAT_FQDN` at start (template: `config/web-client/config.json.template`).
No new env vars. After `docker compose up -d --build`:

- [ ] `https://chat.<DOMAIN>/` loads the Cinny login page with the homeserver fixed to `chat.<DOMAIN>` (no server picker).
- [ ] `https://chat.<DOMAIN>/config.json` shows `homeserverList: ["chat.<DOMAIN>"]`.
- [ ] Register with the token in the browser, land in the Squadz Space, send a message.
- [ ] In `Lounge`, click the call button: mic works, and a friend on Element X hears you. This is risk 1 in [CLIENTS.md](CLIENTS.md) (Cinny ships Element Call 0.20.1, Element X a newer one). If interop fails, switch to the Element Web fallback described there.
- [ ] Screen share from the call controls works (no `Permissions-Policy` header is sent on purpose).
- [ ] Bumping Cinny: change `CINNY_VERSION` and `CINNY_SHA256` together in `caddy/Dockerfile`, rebuild.

## 9. On-device checks (the unverified items from P1)

Run these once the stack is live with a friend. They need real devices, so they are not covered by CI. Record the outcome in `docs/plans/P1-foundation.md` In flight.

- [ ] **Element Call viewer sees the Go-Live tile.** Start a stream from `https://chat.<DOMAIN>/golive/` in a voice room; another member in Element Call sees the screen-share tile.
- [ ] **System audio per OS.** Go-Live with "share system audio" on Windows (Chrome/Edge), macOS and Linux; viewers hear the game audio. Expect gaps on macOS/Linux ([STREAMING.md §3](STREAMING.md)).
- [ ] **1080p60 and 1440p60 reach target fps and bitrate.** Check `getStats` / the page's stats overlay for ~60 fps and the preset bitrate.
- [ ] **CORS chat -> rtc for `/sfu/get`.** From `https://chat.<DOMAIN>/golive/`, the `POST https://rtc.<DOMAIN>/livekit/jwt/sfu/get` call succeeds with no CORS error in the browser console.
- [ ] **lk-jwt room hashing against the live container.** The Go-Live page, Element Call and the soundboard end up in the same LiveKit room (lk-jwt-service 0.4.4 hashes the Matrix room ID; confirm with `docker compose logs lk-jwt-service livekit`).
- [ ] **Element X mobile voice.** Two friends on phones (cellular and Wi-Fi) talk in Lounge for 10 minutes with no drops.

## 10. Day-2

```bash
node scripts/squadz.mjs doctor        # any time something feels off
node scripts/squadz.mjs update        # pull images, recreate, run doctor
node scripts/squadz.mjs backup        # backups/squadz-backup-YYYYMMDD-HHMMSS.tar.gz
node scripts/squadz.mjs restore backups/<file>.tar.gz --yes [--with-config]
```

`backup` briefly stops Tuwunel (a few seconds), tars the RocksDB volume and copies `.env` and `config/` into one archive (mode 600, **contains secrets**: keep it off shared storage). Tuwunel also has an online backup (`!admin server backup-database`, needs `database_backup_path`), but a stopped-volume tar restores by plain untar and needs no extra config. `restore` replaces the live DB, so it needs `--yes`; `--with-config` also restores `.env` and `config/`. `backup --keep N` (default 14) then deletes the oldest `squadz-backup-*.tar.gz` beyond N (nothing else in `backups/` is touched).

**Stay up across reboots + nightly backup** (Linux host with systemd):

```bash
node scripts/squadz.mjs service install --dry-run   # print the units, touch nothing
node scripts/squadz.mjs service install             # uses sudo unless root; safe to re-run
node scripts/squadz.mjs service install --backup-at 03:30 --keep 7   # change the schedule
node scripts/squadz.mjs service status
node scripts/squadz.mjs service uninstall
```

This writes `squadz.service` (oneshot, `docker compose up -d` after `docker.service` + network-online, enabled at boot) and `squadz-backup.service` + `squadz-backup.timer` (nightly `backup`, default 04:00, `Persistent=true` so a missed run fires at next boot). Every compose service is `restart: unless-stopped` (enforced by `scripts/validate.mjs`). `doctor` warns if the service is not enabled or the newest backup is older than 48h.

### Custom emoji & stickers

Discord-style, owner-only (needs the admin account from `.env`):

```bash
node scripts/squadz.mjs emoji add party_parrot ./parrot.gif          # emoji (<= 256KB)
node scripts/squadz.mjs emoji add cat_hello ./hello.webp --sticker   # sticker (<= 512KB)
node scripts/squadz.mjs emoji list
node scripts/squadz.mjs emoji remove party_parrot
```

Shortcodes are `[a-z0-9_]{2,32}`; files must be png, gif, webp or jpg. The image is uploaded once and added to the MSC2545 pack (`im.ponies.room_emotes`) on the Space and every text room, keeping the existing images; re-adding a shortcode replaces it. The picker updates live in Cinny; Element X may need a room reopen.

### Server settings & welcome

```bash
node scripts/squadz.mjs server show
node scripts/squadz.mjs server set --name "Our Squad" --icon ./logo.png --topic general="Chat here" --topic clips="Soundboard: !sb list"
node scripts/squadz.mjs server set --welcome config/welcome.md
```

`--name` sets the Space name; `--icon` (png/jpg/webp, <= 2MB) sets the Space avatar (`--icon-all` also applies it to every room); `--topic ROOM=TEXT` is repeatable and takes a room slug (`general`, `games`, `clips`, `memes`, `lounge`, `game-night`, `squadz`). `--welcome FILE.md` posts the markdown as an `m.notice` in #general (plain `body` plus a minimal-HTML `formatted_body`) and pins it, **replacing** the previous welcome pin; other pins are kept. Everything is idempotent: unchanged values are not rewritten and identical welcome text is not re-posted. `show` prints the name, icon mxc, every topic and the pinned welcome event id.

`bootstrap.mjs` seeds `config/welcome.md` (house rules, channel guide, joining voice, `!sb`, asking for emoji) only if no welcome exists yet, so edit that file and run `server set --welcome config/welcome.md` to republish. Note #general is encrypted: the welcome is sent unencrypted (the CLI has no E2EE), so clients show it with an "unencrypted" shield. It is public house info only; don't put secrets in it.

## Sources

- Tuwunel v1.5.1: `auto_join_rooms` and `registration_token_file` in `tuwunel-example.toml`; auto-join in `src/service/users/register.rs`; `token issue [--once|--max-uses|--max-age]` in `src/admin/token/`; `users list-users` in `src/admin/user/commands.rs`; `server backup-database` in `src/admin/server/`; first user becomes admin in `src/service/users/register.rs`. <https://github.com/matrix-construct/tuwunel>
- lk-jwt-service 0.4.4 `/healthz`: <https://github.com/element-hq/lk-jwt-service>
