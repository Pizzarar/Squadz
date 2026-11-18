// scripts/lib/init.mjs: orchestrator + onboarding summary for `squadz init` (P4 E4).
// Pure of side effects: every step carries its own done()/run(), so tests pass fakes.

export class InitError extends Error {
  constructor(message, step, next) {
    super(message);
    this.step = step;
    this.next = next;
  }
}

/**
 * Run (or, with dryRun, print) the steps in order.
 * step = { id, title, cmd, next, done?: async () => bool, run: async () => void }
 * `ctx.ran` collects the ids that ran (or were planned, in dry-run) so later steps can depend on them.
 * Stops at the first failure with an InitError carrying the exact command to run next.
 */
export async function runInit({ steps, dryRun = false, log = console.log, ctx = { ran: new Set() } }) {
  const total = steps.length;
  const results = [];
  for (const [i, s] of steps.entries()) {
    const tag = `[${i + 1}/${total}] ${s.title}`;
    let done = false;
    if (s.done) {
      try { done = !!(await s.done(ctx)); } catch { done = false; }
    }
    if (dryRun) {
      log(`${tag}: ${done ? "SKIP (already done)" : "RUN"}\n      $ ${s.cmd}`);
      if (!done) ctx.ran.add(s.id);
      results.push({ id: s.id, status: done ? "skipped" : "planned" });
      continue;
    }
    if (done) {
      log(`${tag}: already done, skipping`);
      results.push({ id: s.id, status: "skipped" });
      continue;
    }
    log(`\n${tag} ...\n      $ ${s.cmd}`);
    try {
      await s.run(ctx);
    } catch (err) {
      throw new InitError(`step ${i + 1}/${total} (${s.title}) failed: ${err.message}`, s.id, s.next ?? s.cmd);
    }
    ctx.ran.add(s.id);
    log(`${tag}: done`);
    results.push({ id: s.id, status: "ran" });
  }
  return results;
}

/** The message printed when init stops: exact next command, then the re-run hint. */
export function formatInitFailure(err, rerun) {
  return [
    `squadz init stopped: ${err.message}`,
    "",
    "Fix it, then run this exact command:",
    `  ${err.next}`,
    "",
    "Then resume (finished steps are detected and skipped):",
    `  ${rerun}`,
  ].join("\n");
}

/** Friend-onboarding summary: the invite, hosts + CA steps per OS (mesh mode), the Cinny URL. */
export function buildOnboardingSummary({ env, invite, caFile, caInstructions }) {
  const chat = env.CHAT_FQDN;
  const mesh = ["internal", "internal_tls"].includes(String(env.SQUADZ_TLS ?? "").trim());
  const L = [];
  L.push("", "=".repeat(60), "Squadz is up. Friend onboarding", "=".repeat(60), "");
  L.push(`Web client (Cinny): https://${chat}/`, "");
  if (mesh) {
    L.push("Every friend must do these two things ONCE per device, before opening the link:");
    L.push("");
    L.push(`1. Join your NordVPN Meshnet (or Tailscale), then map the hostnames to the mesh IP in the hosts file:`);
    L.push(`     ${env.MESH_IP} ${env.CHAT_FQDN} ${env.RTC_FQDN}`);
    L.push("     Windows : C:\\Windows\\System32\\drivers\\etc\\hosts  (edit as Administrator)");
    L.push("     macOS   : echo \"<line above>\" | sudo tee -a /etc/hosts");
    L.push("     Linux   : echo \"<line above>\" | sudo tee -a /etc/hosts");
    L.push("");
    L.push(`2. Trust the CA. Send them ${caFile} (a PUBLIC certificate, safe to share), then:`);
    L.push("");
    L.push(caInstructions);
    L.push("");
    L.push("   Element X on Android ignores user-installed CAs; use a desktop browser for this test.");
    L.push("");
  }
  L.push("Invite message to send (single-use registration token):", "", "----- copy from here -----", invite.trim(), "----- to here -----", "");
  L.push(`Later: node scripts/squadz.mjs invite --name <Friend>   |   doctor   |   update`);
  return L.join("\n");
}
