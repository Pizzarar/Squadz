// Parses soundboard chat commands (`!sb ...`).

/**
 * Parse a Matrix m.room.message body for a `!sb` command.
 *
 * Supported commands:
 *   - `!sb` / `!sb list` / `!sb help` -> `{ action: 'list' }`
 *   - `!sb play <clip>`               -> `{ action: 'play', clip: '<clip>' }`
 *   - `!sb stop`                      -> `{ action: 'stop' }`
 *   - Any other `!sb ...`             -> `{ action: 'help', error: '...' }`
 *   - Non-`!sb` message               -> `null`
 *
 * @param {string} body
 * @returns {{ action: 'list' | 'play' | 'stop' | 'help', clip?: string, error?: string } | null}
 */
export function parseCommand(body) {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== '!sb') return null;

  const sub = (tokens[1] || 'list').toLowerCase();

  if (sub === 'list' || sub === 'help') {
    if (tokens.length > 2) {
      return { action: 'help', error: `Unexpected arguments for !sb ${sub}` };
    }
    return { action: 'list' };
  }

  if (sub === 'stop') {
    if (tokens.length > 2) {
      return { action: 'help', error: 'Unexpected arguments for !sb stop' };
    }
    return { action: 'stop' };
  }

  if (sub === 'play') {
    const rawClip = tokens[2];
    if (!rawClip || tokens.length > 3) {
      return { action: 'help', error: 'Usage: !sb play <clip>' };
    }
    const clip = sanitizeClipName(rawClip);
    if (!clip) {
      return { action: 'help', error: `Invalid clip name: ${rawClip}` };
    }
    return { action: 'play', clip };
  }

  return { action: 'help', error: `Unknown subcommand: ${sub}` };
}

/**
 * Normalize a clip identifier, stripping an optional audio extension and
 * rejecting path traversal or non-slug characters.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function sanitizeClipName(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.trim().replace(/\.(mp3|ogg|wav)$/i, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stripped)) return null;
  return stripped;
}
