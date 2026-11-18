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
  await step("hosted web client (Cinny) at /: SPA fallback, locked config, Caddy routes", async () => {
    const root = await fetch(`${cfg.chatUrl}/`);
    assertEq(root.status, 200, "/ status");
    assert((root.headers.get("content-type") ?? "").includes("text/html"), "/ is text/html");
    const html = await root.text();
    assert(/<html/i.test(html), "/ is an HTML document");
    assert(/<title>\s*Cinny/i.test(html) || /cinny/i.test(html), "/ returns Cinny's index.html");
    assert(/id=["']root["']/.test(html), "/ contains Cinny's #root mount point");
    assert(!root.headers.has("permissions-policy"), "no Permissions-Policy header (breaks screen share)");

    // Squadz brand assets are served (same-origin, so the frame-ancestors CSP is untouched).
    const css = await fetch(`${cfg.chatUrl}/squadz.css`);
    assertEq(css.status, 200, "/squadz.css status");
    assert((css.headers.get("content-type") ?? "").includes("text/css"), "/squadz.css is text/css");
    assert(/#2EE6A6/i.test(await css.text()), "/squadz.css carries the Squadz accent");
    for (const p of ["/squadz-init.js", "/squadz/icon-32.png", "/squadz/icon-192.png", "/squadz/icon-512.png", "/squadz/icon.svg"]) {
      const r = await fetch(`${cfg.chatUrl}${p}`);
      assertEq(r.status, 200, `${p} status`);
      assert(!(r.headers.get("content-type") ?? "").includes("text/html"), `${p} is not the SPA fallback`);
      await r.arrayBuffer();
    }
    const man = await (await fetch(`${cfg.chatUrl}/manifest.json`)).json();
    assertEq(man.name, "Squadz", "manifest name");
    assert(man.icons?.length >= 2, "manifest has icons");

    // Locked config: only ours, never cached.
    const conf = await fetch(`${cfg.chatUrl}/config.json`);
    assertEq(conf.status, 200, "/config.json status");
    assert((conf.headers.get("cache-control") ?? "").includes("no-cache"), "config.json is not cached");
    const c = await conf.json();
    assertEq(c.homeserverList, [cfg.chatFqdn], "homeserverList locked to CHAT_FQDN");
    assertEq(c.defaultHomeserver, 0, "defaultHomeserver");
    assertEq(c.allowCustomHomeservers, false, "allowCustomHomeservers locked");
    assertEq(c.featuredCommunities?.rooms, [], "no featured public rooms");

    // History-routed deep links get the exact same SPA index back.
    for (const p of ["/some/deep/link", "/home/", "/home/some-room"]) {
      const d = await fetch(`${cfg.chatUrl}${p}`);
      assertEq(d.status, 200, `${p} SPA fallback status`);
      assertEq(await d.text(), html, `${p} serves the SPA index`);
    }

    // Frame headers: same-origin framing allowed (Element Call widget), cross-origin denied.
    for (const p of ["/", "/public/element-call/index.html"]) {
      const r = await fetch(`${cfg.chatUrl}${p}`);
      assertEq(r.status, 200, `${p} status`);
      assertEq(r.headers.get("x-frame-options"), "SAMEORIGIN", `${p} X-Frame-Options`);
      assertEq(r.headers.get("content-security-policy"), "frame-ancestors 'self'", `${p} CSP`);
      await r.arrayBuffer();
    }

    // /golive redirects to its trailing-slash form, which is served.
    const rd = await fetch(`${cfg.chatUrl}/golive`, { redirect: "manual" });
    assertEq(rd.status, 308, "/golive redirect status");
    assert((rd.headers.get("location") ?? "").endsWith("/golive/"), "/golive Location ends with /golive/");
    await rd.arrayBuffer();
    const golive = await fetch(`${cfg.chatUrl}/golive/`);
    assertEq(golive.status, 200, "/golive/ still served");

    // Cinny's catch-all must not shadow the API routes.
    const v = await fetch(`${cfg.chatUrl}/_matrix/client/versions`);
    assertEq(v.status, 200, "/_matrix/client/versions still proxied to Tuwunel");
    assert((v.headers.get("content-type") ?? "").includes("json"), "versions is JSON, not index.html");
    const versions = (await v.json()).versions;
    assert(Array.isArray(versions) && versions.length > 0, "versions array is non-empty");
    const wk = await fetch(`${cfg.chatUrl}/.well-known/matrix/client`);
    assertEq(wk.status, 200, "well-known/matrix/client still served");
    assert((wk.headers.get("content-type") ?? "").includes("json"), "well-known is JSON, not index.html");
    assert(Boolean((await wk.json())["org.matrix.msc4143.rtc_foci"]), "well-known still carries rtc_foci");

    // A hashed asset referenced from index.html is served as JS.
    const m = html.match(/(?:src|href)=["']([^"']+\.js)["']/);
    assert(m, "index.html references a .js asset");
    const a = await fetch(new URL(m[1], `${cfg.chatUrl}/`));
    assertEq(a.status, 200, `${m[1]} status`);
    assert(/javascript/.test(a.headers.get("content-type") ?? ""), `${m[1]} JS content-type`);
    await a.arrayBuffer();
  });
});
