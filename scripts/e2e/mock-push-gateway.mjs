// Minimal Matrix push gateway for the e2e (block D5). Runs as the `push-mock` service in
// docker-compose.ci.yml. Accepts POST /_matrix/push/v1/notify like Sygnal does and records the
// bodies; the runner reads them back from GET /received. TEST ONLY.
import http from "node:http";

const received = [];
http.createServer((req, res) => {
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/received") return json(200, received);
  if (req.method === "GET" && req.url === "/healthz") return json(200, { ok: true });
  if (req.method === "POST" && req.url === "/_matrix/push/v1/notify") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { received.push({ unparsable: true }); }
      json(200, { rejected: [] });
    });
    return;
  }
  json(404, { errcode: "M_UNRECOGNIZED" });
}).listen(8080, "0.0.0.0", () => console.log("mock push gateway on :8080"));
