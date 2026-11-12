// scripts/lib/config.mjs
//
// Environment/config resolution for bootstrap.mjs. Reads Matrix connection and
// seeding settings from process.env (optionally pre-loaded from a --env-file),
// with the homeserver base URL derived from CHAT_FQDN unless overridden.

import { readFileSync } from "node:fs";

/**
 * Load KEY=VALUE pairs from a simple .env-style file into process.env.
 * Supports `#` comments, blank lines, and single/double-quoted values.
 * Throws if the file cannot be read.
 *
 * @param {string} filePath
 */
export function loadEnvFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) process.env[key] = value;
  }
}

/**
 * Turn a localpart ("aub") or full MXID ("@aub:chat.example") into a full MXID.
 *
 * @param {string} user
 * @param {string} serverName
 * @returns {string}
 */
export function toUserId(user, serverName) {
  if (user.includes(":")) return user;
  return `@${user}:${serverName}`;
}

/**
 * Turn a localpart ("aub") or full MXID ("@aub:chat.example") into a localpart.
 *
 * @param {string} user
 * @returns {string}
 */
export function toLocalpart(user) {
  if (user.startsWith("@")) return user.slice(1).split(":")[0];
  return user;
}

/**
 * Resolve the seeding configuration from the environment.
 *
 * Required: CHAT_FQDN, SQUADZ_ADMIN_PASSWORD, TUWUNEL_REGISTRATION_TOKEN.
 * Optional: HOMESERVER_URL (defaults to https://CHAT_FQDN; tests point this at
 *           a mock), SQUADZ_ADMIN_USER (default "admin").
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function resolveConfig(env = process.env) {
  const serverName = env.CHAT_FQDN;
  if (!serverName) {
    throw new Error("CHAT_FQDN is required (set it in the environment or via --env-file)");
  }

  const adminPassword = env.SQUADZ_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("SQUADZ_ADMIN_PASSWORD is required (set it in the environment or via --env-file)");
  }

  const adminUser = env.SQUADZ_ADMIN_USER || "admin";

  return {
    // Matrix server_name. Also used as the :suffix on user IDs and room aliases.
    serverName,
    // Base URL for the client-server API (no trailing slash).
    homeserverUrl: (env.HOMESERVER_URL || `https://${serverName}`).replace(/\/+$/, ""),
    registrationToken: env.TUWUNEL_REGISTRATION_TOKEN || "",
    adminUser: toLocalpart(adminUser),
    adminUserId: toUserId(adminUser, serverName),
    adminPassword,
  };
}
