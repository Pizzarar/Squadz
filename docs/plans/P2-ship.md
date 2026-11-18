# P2 — Ship it: ops CLI, web client, real-stack e2e

Lead: Squ2. Base: `dev` c68c1d6 (P1 code-complete). Goal: when Aub supplies the domain and Cloudflare token, one command brings the stack up, friends join from a link, and CI has already proven the real stack works.

## Decided (lead calls, owner delegated 2026-11-17: "make the decisions")
- **Mesh default: Tailscale.** It is free for 3 users, has iOS, Android, Windows and macOS apps, and `tailscale ip -4` is scriptable. NordVPN Meshnet stays supported as the alternative (P1 contract is provider-agnostic).
- **Host: a Linux box with Docker Engine + compose (Ubuntu 24.04 LTS reference).** Windows is supported only through WSL2 with mirrored networking, documented as second-class: Docker Desktop's port publishing for the 50000-50100/udp range is the weak spot. The dev PC has no Docker/WSL, so real-stack testing runs in CI.
- **Friends: no hard-coded usernames.** Each friend picks their own. Registration stays token-gated. `squadz invite` prints a pasteable onboarding message (server, token, app links). New users auto-join the Space and its rooms via Tuwunel `auto_join_rooms` (worker verifies the option name in Tuwunel source; fallback is bootstrap re-run inviting all members).
- **Roles (Discord-style) = power levels:** owner 100, mod 50, member 0. `squadz role <user> owner|mod|member` applies across the Space and its rooms.
- **Desktop/web: host a web client at `https://CHAT_FQDN/`** so friends need nothing installed; Element X stays the mobile client. Which client is decided by C3a from sources (criteria below); lead lean is Element Web for its built-in Element Call voice, unless Cinny's MatrixRTC calls are real today.
- **One ops entry point:** `node scripts/squadz.mjs <setup|doctor|invite|role|backup|restore|update>`.
- **Testing:** real-stack e2e in GitHub Actions (compose up with a CI override: Caddy `tls internal`, fake FQDNs in /etc/hosts). It runs once `dev` is pushed; pushing `Pizzarar/Squadz` (public) is waiting on Aub's OK.
- Primitives checked: `vs --help` (no worktree verb in this build, so plain `git worktree` under `~/.paseo/worktrees/squadz`), existing `scripts/bootstrap.mjs` + `scripts/validate.mjs` (reused, not replaced).

## Blocks
| block | profile | touches | clashes with |
|---|---|---|---|
| C1 real-stack e2e CI | Implement - Sonnet | `.github/workflows/e2e.yml` (new), `docker-compose.ci.yml` (new), `caddy/Caddyfile` (env-switch for internal TLS only), `scripts/e2e/*` (new) | C3b (Caddyfile, compose) |
| C2 ops CLI + onboarding + roles | Implement - Sonnet | `scripts/squadz.mjs` (new), `scripts/lib/*`, `scripts/test/*`, `config/tuwunel.toml`, `.env.example`, `docs/SETUP.md`, `docs/ONBOARDING.md`, `docs/DEPLOY.md` (new) | C1 (`.env.example` read only) |
| C3a web-client choice | Implement - Sonnet | `docs/CLIENTS.md` (new) | none |
| C3b web-client hosting | after C3a + C1 merge | `docker-compose.yml`, `caddy/Caddyfile`, `config/web-client/*` | C1 |

C1, C2 and C3a run in parallel. C3b waits for C1 to merge, because both edit the Caddyfile and compose.

## Review
Each block goes to Review - Gemini (Claude wrote it). The reviewer's own first line must be `PASS|FAIL H/M/L <tip-hash>`, and the lead merges only when that hash is the branch tip.

## In flight
- 2026-11-17: P2 opened. C1, C2, C3a dispatched (worktrees `~/.paseo/worktrees/squadz/c1..c3`, branches `unit/c1..c3` off c68c1d6).
- C3a: PASS 0/0/0 ee2841f (narrow re-review rn-a47a56854951; first reviewer hit 253k with no verdict and was cancelled). Pick: Cinny v4.12.8. MERGED.
- C1: PASS 0/0/2 89b6508 (rn-b81d13540bbc). MERGED. C2: PASS 0/0/3 34eae6f (rn-318e0f90c36b). MERGED (.gitignore union conflict resolved) at 2b21dcf. dev: validate 10/10, scripts 27/27, e2e helpers 6/6.
- In flight: C3b host Cinny (Implement - Sonnet rn-97ad090d79a3, unit/c3b); C4 = the 5 lows from the C1/C2 reviews (Work Order - DSP rn-750c7a1b275e, unit/c4). No clash: C4 doesn't touch compose/Caddyfile.
- Real-stack e2e has never run: it needs `dev` pushed (owner OK pending).
