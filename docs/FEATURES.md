# Feature notes: search and threads

Cinny (the web client) relies on three server endpoints. `scripts/e2e/2e-search.mjs` (CI phase 2e)
exercises them against the real Tuwunel in the compose stack:

| Cinny feature | Endpoint | E2E check |
|---|---|---|
| Room search | `POST /_matrix/client/v3/search` (`room_events`) | two fresh messages are found by a unique term |
| Thread replies | `PUT .../send/m.room.message` with `m.relates_to.rel_type = m.thread` | reply accepted |
| Thread view | `GET /_matrix/client/v1/rooms/{room}/relations/{root}/m.thread` | reply is in `chunk` |
| Threads list | `GET /_matrix/client/v1/rooms/{room}/threads` | root listed, with bundled `m.relations.m.thread` summary (count, latest_event) |

If an endpoint is missing, the step fails with `MISSING ENDPOINT: ...` naming the endpoint. The
legacy `/v3/.../relations` alias is probed but only reported, not required.

Status (E2E run 44410394273, all four checks PASS on the pinned Tuwunel): `/v3/search`, `m.thread`
replies, `/v1/.../relations/{root}/m.thread` and `/v1/.../threads` (with bundled thread summary) all
work. The legacy `/v3/.../relations` alias returns HTTP 404; Cinny does not need it.

Implemented search/thread sanity checks against Cinny's needs — Thanks to Cinny by Ajay Bura.
