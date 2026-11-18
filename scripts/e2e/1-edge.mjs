// Phase 1: Caddy edge over TLS (needs NODE_EXTRA_CA_CERTS = Caddy's internal root, and the FQDNs in /etc/hosts).
import { assert, assertEq, loadConfig, run, step, waitFor } from "./lib.mjs";

run(async () => {
  const cfg = loadConfig();

  await step("well-known/matrix/client via Caddy TLS", async () => {
    const res = await waitFor(
      "Caddy + Tuwunel behind TLS",
      async () => {
        const r = await fetch(`${cfg.chatUrl}/.well-known/matrix/client`);
        return r.ok ? r : null;
      },
      { timeoutMs: 120_000, intervalMs: 2_000 },
    );
    assertEq(res.status, 200, "well-known status");
    const body = await res.json();
    assertEq(body["m.homeserver"]?.base_url, cfg.chatUrl, "m.homeserver.base_url");
    const foci = body["org.matrix.msc4143.rtc_foci"];
    assert(Array.isArray(foci) && foci.length === 1, "rtc_foci has one entry");
    assertEq(foci[0], { type: "livekit", livekit_service_url: `${cfg.rtcUrl}/livekit/jwt` }, "rtc_foci[0]");
  });

  await step("well-known/matrix/server via Caddy TLS", async () => {
    const res = await fetch(`${cfg.chatUrl}/.well-known/matrix/server`);
    assertEq(res.status, 200, "status");
    assertEq(await res.json(), { "m.server": `${cfg.chatFqdn}:443` }, "m.server");
  });

  await step("_matrix/client/versions proxied to Tuwunel", async () => {
    const res = await fetch(`${cfg.chatUrl}/_matrix/client/versions`);
    assertEq(res.status, 200, "status");
    const body = await res.json();
    assert(Array.isArray(body.versions) && body.versions.length > 0, "versions array is non-empty");
  });

  await step("lk-jwt-service health + CORS preflight via RTC FQDN", async () => {
    const res = await fetch(`${cfg.rtcUrl}/livekit/jwt/healthz`);
    assertEq(res.status, 200, "lk-jwt-service /healthz through /livekit/jwt");
    const pre = await fetch(`${cfg.rtcUrl}/livekit/jwt/sfu/get`, { method: "OPTIONS" });
    assertEq(pre.status, 204, "CORS preflight status");
    assertEq(pre.headers.get("access-control-allow-origin"), "*", "CORS allow-origin");
  });

  await step("LiveKit SFU reachable via /livekit/sfu", async () => {
    const res = await fetch(`${cfg.rtcUrl}/livekit/sfu/`);
    assertEq(res.status, 200, "LiveKit root status");
  });

  await step("/golive/ static app served over TLS", async () => {
    const redirect = await fetch(`${cfg.chatUrl}/golive`, { redirect: "manual" });
    assertEq(redirect.status, 308, "/golive redirect status");
    const res = await fetch(`${cfg.chatUrl}/golive/`);
    assertEq(res.status, 200, "/golive/ status");
    const html = await res.text();
    assert(/<html/i.test(html), "/golive/ returns an HTML document");
    for (const asset of ["app.mjs", "lib/publish.mjs", "styles.css", "vendor/livekit-client.esm.mjs"]) {
      const a = await fetch(`${cfg.chatUrl}/golive/${asset}`);
      assertEq(a.status, 200, `/golive/${asset} status`);
    }
  });
});
