# P5 · Discord-feel polish, part 2 (Meshnet, no Cloudflare)

## Decided (lead calls, Squ3)
- **Owner directive:** keep building a polished, functional Discord-style app autonomously. The first Meshnet test waits on the owner, and P5 doesn't block it.
- **G1 Go-Live entry:** Cinny has no native "Go Live" button. Add a Go-Live button or banner in voice rooms through the existing `caddy/brand/squadz-init.js` injection (E2). It links to `/golive?room=<roomId>`, and `/golive` prefills from that query parameter. First check whether Cinny's bundled Element Call already supports screenshare; if it does, document it and keep the button as the high-FPS path.
- **G2 search + threads sanity:** add an E2E step proving that Tuwunel serves `/search` and thread relations (`m.thread`) the way Cinny uses them. Fold in idea-341: meshIo CA_FILE resolves from the env-file directory (scripts/squadz.mjs:277).
- Primitives checked: `caddy/brand/squadz-init.js` and the Dockerfile grep assertions (E2/F1), `web/golive` (B4b), scripts/e2e/* steps (C1), and `vs inbox` idea-341.

## Blocks
| block | what | touches | clashes with |
|---|---|---|---|
| G1 | Go-Live entry in Cinny voice rooms + /golive room prefill | caddy/brand/squadz-init.js, caddy/Dockerfile, web/golive, scripts/e2e/1-edge.mjs | none |
| G2 | search/threads E2E + idea-341 fix | scripts/e2e/2e-search.mjs (new), scripts/e2e/package.json, scripts/squadz.mjs, scripts/test | none |

G1 and G2 run in parallel. The only shared surface is scripts/e2e/package.json, which needs a union merge if G1 touches it.

## In flight
