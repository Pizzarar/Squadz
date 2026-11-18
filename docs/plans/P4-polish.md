# P4 · Polished, functional over Meshnet (no Cloudflare)

Owner (2026-11-18): "Will be hosting over meshnet to start testing so don't worry about Cloudflare. I just need this in a good looking functional state. Proceed with whatever you need to get there to the polished discord clone."

## Decided (lead calls)
- **First-test hosting = NordVPN Meshnet with no domain and no Cloudflare.**
  - New TLS mode `SQUADZ_TLS=internal`. The Caddyfile switch already exists, since CI uses it.
  - `squadz setup --mesh-only` asks only for the mesh IP. It picks hostnames `chat.squadz.mesh` / `rtc.squadz.mesh` (overridable), writes `.env`, and exports Caddy's root CA to `squadz-ca.crt`.
  - It also prints the per-device trust and hosts-file steps for Windows, macOS, Linux, iOS and Android.
  - DNS: Meshnet has no custom DNS. Each device either adds a hosts entry, or uses the Meshnet peer nickname, which resolves as `<nick>.nord` on Meshnet. Pick whichever works with a Caddy site name, and document it.
- **Client order for the first test:** desktop browser → hosted Cinny at `https://chat.<host>/` once the CA is trusted.
  - This is the polished, Discord-like primary.
  - Element X on phones is best-effort in internal-TLS mode: Android apps ignore user CAs by default.
  - Doc the limit plus the later fix: a real domain, by any DNS-01 provider, once the owner wants phones.
- **"Good looking" = a Discord-like Squadz brand on every surface we control:**
  - Cinny gets title/favicon/manifest, a default dark theme, a Squadz accent CSS injected at image build, and login branding.
  - Space and room icons, real emoji pack art, and a styled /golive page.
  - Chrome readability first. One light surreal touch is allowed, such as the logo or the empty-state art.
- Primitives checked: the existing `squadz setup` (scripts/squadz.mjs), the Caddyfile `{$SQUADZ_TLS}` switch, `squadz server set` (D3), `squadz emoji` (D1), and the C3b Cinny Dockerfile pin.

## Blocks
| Block | Scope | Touches | Clashes with |
|---|---|---|---|
| E1 | Meshnet mode: `setup --mesh-only`, internal TLS, CA export, `doctor` in mesh mode, DEPLOY-MESHNET.md runbook | scripts/squadz.mjs, lib/ops.mjs, Caddyfile, docs | E3 (squadz.mjs) |
| E2 | Brand + look: Cinny theme/CSS/favicon/title injected in caddy/Dockerfile, /golive restyle, logo/icon assets in assets/brand/ | caddy/Dockerfile, web/, assets/ | none |
| E3 | Seed art: Space/room avatars + real emoji pack art wired into bootstrap via D1/D3 helpers | scripts/lib/seed.mjs, assets/ | E1 (after E1 merges) |
| E4 | One-shot `squadz init` (setup → up → bootstrap → restart → doctor → first invite) | scripts/squadz.mjs | E1, E3 (last) |

## In flight
- 2026-11-18: P4 opened. E1 and E2 dispatched in parallel.
