# AGENTS.md · Squadz

Self-hosted private chat + voice for a small friend group ("where squadz meet"): Tuwunel (Matrix
homeserver) + LiveKit (MatrixRTC voice/video), reachable only over an L3 mesh (NordVPN Meshnet or
Tailscale), with real-domain TLS via ACME DNS-01. Clients: Element X (mobile), Element (desktop).

## Layout
- `docker-compose.yml`, `.env.example`: the whole stack. Every `${VAR}` in compose must exist in `.env.example`.
- `caddy/`: Caddy image (with DNS-01 provider plugin) and Caddyfile. TLS terminator for everything.
- `config/`: `tuwunel.toml`, `livekit.yaml` and other service config.
- `scripts/`: validation, bootstrap and seeding scripts (Node 20+, no global installs).
- `bots/<name>/`: each bot is its own package with its own `package.json`, tests and Dockerfile.
- `web/<name>/`: static web apps served by Caddy.
- `docs/`: SETUP, ONBOARDING, STREAMING and plans (`docs/plans/`).

## Rules
- Branches: work on `unit/<id>` off `dev`. The lead merges into `dev`. Never commit to `main`.
- Worktrees live in `C:\Users\Fugma\.paseo\worktrees\squadz\<unit>`, never as sibling folders in `projects/`.
- No secrets in git. Real values go in `.env` (gitignored). Use `<PLACEHOLDER>` style in docs.
- The host machine has no Docker. Verify statically: `node scripts/validate.mjs` plus each package's
  `npm test`. CI (`.github/workflows/ci.yml`) runs the real `docker compose` smoke test.
- Only run tests for your own files. Report with evidence (command output, file:line, commit hash).
- Keep the shared contract in `docs/plans/P1-foundation.md` § Contract. Changing an env name, hostname,
  port or service name means updating the contract in the same commit and saying so in your final message.
- Attribution: record borrowed ideas in `CREDITS.md` as
  "Implemented <feature> — Thanks to <Project> by <Author>".
