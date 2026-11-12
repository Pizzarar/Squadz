#!/usr/bin/env node
// scripts/bootstrap.mjs
//
// Idempotently seed the Squadz Space, rooms, emoji pack and friend invites on
// a running homeserver (Tuwunel). See docs/plans/P1-foundation.md § B2.
//
// Usage:
//   node scripts/bootstrap.mjs [--env-file .env] [--invite @a:chat.dom @b:chat.dom] [--homeserver-url http://127.0.0.1:8080]
//
// Config comes from the environment (or --env-file); CHAT_FQDN,
// SQUADZ_ADMIN_PASSWORD and TUWUNEL_REGISTRATION_TOKEN are required.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvFile, resolveConfig, toUserId } from "./lib/config.mjs";
import { createMatrixClient } from "./lib/matrix.mjs";
import { seed } from "./lib/seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node bootstrap.mjs [options]

Options:
  --env-file <path>      Load KEY=VALUE config from a .env-style file.
  --invite <user> ...    Invite these users (localpart, @localpart or full @user:server).
  --homeserver-url <url> Override the homeserver base URL (default https://CHAT_FQDN).
  -h, --help             Show this help.

Required environment: CHAT_FQDN, SQUADZ_ADMIN_PASSWORD, TUWUNEL_REGISTRATION_TOKEN.
Optional environment: SQUADZ_ADMIN_USER (default "admin").
`;

function parseArgs(argv) {
  const opts = { envFile: null, invite: [], homeserverUrl: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env-file" || arg === "-e") {
      opts.envFile = argv[++i];
      if (!opts.envFile) throw new Error(`${arg} requires a path`);
    } else if (arg === "--homeserver-url") {
      opts.homeserverUrl = argv[++i];
      if (!opts.homeserverUrl) throw new Error(`${arg} requires a URL`);
    } else if (arg === "--invite") {
      // Collect every following argument up to the next option flag. Accepts a
      // localpart ("aub"), a bare MXID localpart ("@aub") or a full MXID
      // ("@aub:chat.example"); toUserId() normalises them all.
      while (argv[i + 1] && !argv[i + 1].startsWith("-")) opts.invite.push(argv[++i]);
    } else if (arg.startsWith("--invite=")) {
      opts.invite.push(arg.slice("--invite=".length));
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg.startsWith("@")) {
      opts.invite.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (opts.envFile) loadEnvFile(opts.envFile);
  if (opts.homeserverUrl) process.env.HOMESERVER_URL = opts.homeserverUrl;

  const config = resolveConfig();
  config.invite = opts.invite.map((u) => toUserId(u, config.serverName));
  config.emojiDir = path.resolve(here, "..", "assets", "emoji");

  const client = createMatrixClient(config.homeserverUrl);

  process.stdout.write(`Homeserver: ${config.homeserverUrl}\n`);
  process.stdout.write(`Server name: ${config.serverName}\n`);

  const summary = await seed(client, config, (msg) => process.stdout.write(`  ${msg}\n`));

  process.stdout.write("\nDone.\n");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`bootstrap failed: ${err.message}\n`);
  if (err.errcode) process.stderr.write(`  errcode: ${err.errcode}\n`);
  process.exit(1);
});
