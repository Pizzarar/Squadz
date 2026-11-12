// Entrypoint for the `soundboard` Docker service.
// Reads contract env vars:
//   - CHAT_FQDN
//   - RTC_FQDN
//   - SOUNDBOARD_MATRIX_USER
//   - SOUNDBOARD_MATRIX_PASSWORD
//   - SOUNDBOARD_CLIPS_DIR (default `/clips`)
import { MatrixClient } from './matrix.js';
import { SoundboardBot } from './bot.js';

export function loadConfigFromEnv(env = process.env) {
  const chatFqdn = env.CHAT_FQDN?.trim();
  const rtcFqdn = env.RTC_FQDN?.trim();
  const matrixUser = env.SOUNDBOARD_MATRIX_USER?.trim();
  const matrixPassword = env.SOUNDBOARD_MATRIX_PASSWORD;
  const clipsDir = env.SOUNDBOARD_CLIPS_DIR?.trim() || '/clips';
  const idleTimeoutMs = env.SOUNDBOARD_IDLE_TIMEOUT_MS
    ? Number(env.SOUNDBOARD_IDLE_TIMEOUT_MS)
    : 60_000;

  const missing = [];
  if (!chatFqdn) missing.push('CHAT_FQDN');
  if (!rtcFqdn) missing.push('RTC_FQDN');
  if (!matrixUser) missing.push('SOUNDBOARD_MATRIX_USER');
  if (!matrixPassword) missing.push('SOUNDBOARD_MATRIX_PASSWORD');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    chatFqdn,
    rtcFqdn,
    matrixUser,
    matrixPassword,
    clipsDir,
    idleTimeoutMs,
  };
}

async function main() {
  const cfg = loadConfigFromEnv(process.env);
  const matrix = new MatrixClient({ homeserverUrl: `https://${cfg.chatFqdn}` });

  const { userId, deviceId } = await matrix.login(cfg.matrixUser, cfg.matrixPassword);
  console.info(`[soundboard] Logged in as ${userId} (device ${deviceId})`);

  const bot = new SoundboardBot({
    matrix,
    rtcFqdn: cfg.rtcFqdn,
    clipsDir: cfg.clipsDir,
    idleTimeoutMs: cfg.idleTimeoutMs,
  });

  const onSignal = async (sig) => {
    console.info(`[soundboard] Received ${sig}, shutting down...`);
    await bot.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  await bot.start();
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain && !process.env.NODE_TEST_CONTEXT) {
  main().catch((err) => {
    console.error('[soundboard] Fatal error:', err);
    process.exit(1);
  });
}
