// Phase 2e (block G2): server-side search + threads, the endpoints Cinny relies on.
// Sends messages in #general, checks POST /search finds them, sends an m.thread reply, then checks
// /relations (v1, and the v3 alias older SDKs use) and GET /threads return it. If Tuwunel lacks an
// endpoint the step fails with "MISSING ENDPOINT: ..." so the gap is explicit (see docs/FEATURES.md).
import { assert, assertEq, loadConfig, loggedInClient, readState, run, sendText, step, waitFor } from "./lib.mjs";

/** Call an endpoint; on 404/405/501 throw a clear "missing endpoint" error, otherwise rethrow. */
async function probe(client, method, path, opts, what) {
  try {
    return await client.request(method, path, opts);
  } catch (err) {
    if ([404, 405, 501].includes(err.status) && (!err.errcode || err.errcode === "M_UNRECOGNIZED")) {
      throw new Error(`MISSING ENDPOINT: ${what} (${method} ${path.split("?")[0]}) -> HTTP ${err.status} ${err.errcode ?? ""}. Cinny needs it.`);
    }
    throw err;
  }
}

run(async () => {
  const cfg = loadConfig();
  const room = readState().roomIds?.general;
  assert(room, "state.json has the #general room id from phase 2");
  const { client } = await loggedInClient(cfg, cfg.adminUser, cfg.adminPassword);
  const enc = encodeURIComponent(room);
  const tag = `squadzsearch${Date.now().toString(36)}`;
  let root;

  await step("server-side /search finds freshly sent messages", async () => {
    root = (await sendText(client, room, `${tag} needle root`)).event_id;
    await sendText(client, room, `${tag} needle second`);
    const hits = await waitFor("search index to return both messages", async () => {
      const res = await probe(client, "POST", "/_matrix/client/v3/search", {
        body: { search_categories: { room_events: { search_term: tag, filter: { rooms: [room] }, order_by: "recent" } } },
      }, "message search");
      const results = res?.search_categories?.room_events?.results ?? [];
      return results.length >= 2 ? results : null;
    }, { timeoutMs: 30_000 });
    assert(hits.some((r) => r.result?.event_id === root), "search results include the root message");
    assert(hits.every((r) => typeof r.result?.content?.body === "string"), "results carry event content");
  });

  let reply;
  await step("send a thread reply (m.relates_to rel_type m.thread)", async () => {
    const txn = `e2e-thread-${Date.now()}`;
    const res = await client.request("PUT", `/_matrix/client/v3/rooms/${enc}/send/m.room.message/${txn}`, {
      body: {
        msgtype: "m.text", body: `${tag} thread reply`,
        "m.relates_to": { rel_type: "m.thread", event_id: root, is_falling_back: true, "m.in_reply_to": { event_id: root } },
      },
    });
    reply = res.event_id;
    assert(reply, "thread reply has an event id");
  });

  await step("/relations/{root}/m.thread returns the reply (v1; v3 alias informational)", async () => {
    const rel = (v) => `/_matrix/client/${v}/rooms/${enc}/relations/${encodeURIComponent(root)}/m.thread`;
    const res = await waitFor("v1 relations to list the reply", async () => {
      const r = await probe(client, "GET", rel("v1"), undefined, "relations (v1)");
      return r?.chunk?.some((e) => e.event_id === reply) ? r : null;
    }, { timeoutMs: 20_000 });
    assertEq(res.chunk.find((e) => e.event_id === reply).content["m.relates_to"].rel_type, "m.thread", "rel_type");
    // v3 is a legacy/unstable alias some SDK versions try first; report, don't fail.
    const v3 = await client.request("GET", rel("v3")).then(() => "served", (e) => `HTTP ${e.status}`);
    console.log(`  note: /v3 relations alias: ${v3}`);
  });

  await step("GET /threads lists the thread root with a thread summary", async () => {
    const res = await waitFor("threads list to include the root", async () => {
      const r = await probe(client, "GET", `/_matrix/client/v1/rooms/${enc}/threads?include=all`, undefined, "threads list");
      return r?.chunk?.find((e) => e.event_id === root) ?? null;
    }, { timeoutMs: 20_000 });
    const summary = res.unsigned?.["m.relations"]?.["m.thread"];
    assert(summary, "root carries an unsigned m.relations m.thread bundle");
    assert(summary.count >= 1, `thread count >= 1 (got ${summary.count})`);
    assertEq(summary.latest_event?.event_id, reply, "latest_event is the reply");
  });
});
