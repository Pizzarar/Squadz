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
- C3b: PASS 0/0/3 e01f7e1 (rn-1080ae09cfce). MERGED; doc lows fixed by lead 9cc47ef.
- C4 (C1/C2 lows): PASS 0/0/0 aa7014a (rn-65d418e29d1b). MERGED aa508d4.
- C5 (CI green): PASS 0/0/0 c2d8e7d (rn-8bdf34654cbe). MERGED fc780e4. Real bugs: no lockfiles; broken /golive redir. dev CI 44244328409 + E2E 44244328424 GREEN (first real-stack run on dev).
- C6 (invite web link default, --no-web): PASS 0/0/0 188e92a. MERGED 676f854.
- C7 (E2E Cinny + Caddy routes): PASS 0/0/2 2132df3. MERGED e910b9c. C8 (C7/D1 lows): PASS 716f365. MERGED 6991e75.

## P3 · Discord features (opened 2026-11-18)

| Block | Scope | Clashes with |
|---|---|---|
| D1 | `squadz emoji add/remove/list` (MSC2545 emoticon/sticker) | D3 (squadz.mjs) |
| D2 | soundboard uploads from chat (`!sb add/remove`, mod-gated) | none (bots/) |
| D3 | `squadz server show/set` (name, icon, topics, pinned welcome) | D1 (squadz.mjs; D1 merged first) |

- D1: PASS 0/0/1 ce5a447 (rn-14c9978ea5ea). MERGED d5bbdb8.
- D2: FAIL 1/1/1 a766717 (ffmpeg no timeout/decoded cap; name regex). Fixed aaaaa5f, in re-review rn-5ee3dc438696.
- D3: DONE 1013f17, CI+E2E green; in review rn-ae1a0388118a.
- D2: re-review PASS 0/0/0 aaaaa5f. MERGED 4e8e951. D3: FAIL 1/0/1 (--topic parse) -> fixed 661afea, PASS 0/0/0. MERGED e4aa55f.
- D4 (squadz service: boot unit + nightly backup timer, backup --keep, doctor warnings): PASS 0/0/1 66d5bc9. D5 (phone push: Tuwunel pushes to matrix.org Sygnal with federation off; E2E mock gateway proves /notify): PASS 0/0/0 8e0b809. Both MERGED 0baf21e (lead resolved union conflicts).
- C9 (flaky soundboard upload tests, unref'd AbortSignal.timeout): PASS 0/0/0 b3cec2b. MERGED 7911c7f. C10 (D4 low: systemd unit escaping) 8a9c63f in review rn-164d79a016ec.
