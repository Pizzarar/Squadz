// scripts/lib/push.mjs
//
// Phone-notification plumbing checks (block D5). Element X (iOS + Android/FCM) registers an HTTP
// pusher whose URL is https://matrix.org/_matrix/push/v1/notify (Element's Sygnal gateway); Tuwunel
// POSTs event_id_only notifications there over the open internet. `squadz doctor` uses this to
// prove the tuwunel container can reach that gateway.
// Sources: element-x-ios AppSettings.swift (pushGatewayBaseURL), element-x-android
// FirebaseConfig.kt (PUSHER_HTTP_URL), tuwunel v1.5.1 src/service/pusher/{send,request}.rs.

export const PUSH_GATEWAY_URL = "https://matrix.org/_matrix/push/v1/notify";

/** Any HTTP answer (even 4xx/405 to a GET) proves DNS + TCP + TLS to the gateway work. */
export function parseHttpStatus(text) {
  const m = /\b([1-5]\d\d)\b/.exec(String(text ?? "").trim());
  return m ? Number(m[1]) : 0;
}

/**
 * Probe from inside the tuwunel container (curl, then wget), falling back to the host.
 * @param {(cmd: string, args: string[]) => {status: number|null, stdout?: string, stderr?: string, error?: Error}} run
 * @param {(url: string) => Promise<number>} hostStatus  host-side HTTP status (0 on failure)
 * @returns {Promise<{via: "container"|"host", status: number}>}
 */
export async function probePushGateway(run, hostStatus, url = PUSH_GATEWAY_URL) {
  const exec = (...cmd) => run("docker", ["compose", "exec", "-T", "tuwunel", ...cmd]);
  const curl = exec("curl", "-sS", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", url);
  if (!curl.error && curl.status === 0) {
    const status = parseHttpStatus(curl.stdout);
    if (status) return { via: "container", status };
  }
  // busybox wget prints "HTTP/1.1 405 ..." / "server returned error: HTTP/1.1 405" on stderr
  const wget = exec("wget", "-S", "--spider", "-T", "10", "-O", "/dev/null", url);
  if (!wget.error) {
    const m = /HTTP\/\d(?:\.\d)? (\d{3})/.exec(`${wget.stderr ?? ""}${wget.stdout ?? ""}`);
    if (m) return { via: "container", status: Number(m[1]) };
  }
  return { via: "host", status: await hostStatus(url) };
}

/** @param {{via: string, status: number}|null} probe */
export function checkPushGateway(probe) {
  const label = "push gateway reachable (phone notifications)";
  if (!probe || !probe.status) {
    return {
      name: label, ok: false, detail: `no HTTP response from ${PUSH_GATEWAY_URL}`,
      fix: "The host needs outbound HTTPS (443) to matrix.org: check firewall/DNS. Tuwunel POSTs pushes there; Element X registers it. See docs/SETUP.md 'Phone notifications'.",
    };
  }
  const where = probe.via === "container"
    ? "from the tuwunel container"
    : "from the host only (tuwunel image has no curl/wget, so container egress is unproven)";
  return { name: label, ok: true, detail: `HTTP ${probe.status} ${where}` };
}
