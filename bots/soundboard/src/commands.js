// Parses soundboard chat commands (`!sb ...`).
import { CLIP_NAME_RE } from './upload.js';

/**
 * Parse a Matrix m.room.message body for a `!sb` command.
 *
 * Supported commands:
 *   - `!sb` / `!sb list` / `!sb help` -> `{ action: 'list' }`
 *   - `!sb play <clip> [in <room>]`   -> `{ action: 'play', clip: '<clip>', room?: '<room>' }`
 *   - `!sb stop [in <room>]`          -> `{ action: 'stop', room?: '<room>' }`
 *   - `!sb add <name> [--replace]`   -> `{ action: 'add', clip, replace }` (sent as a reply to an audio message)
 *   - `!sb remove <name>`             -> `{ action: 'remove', clip }`
 *   - Any other `!sb ...`             -> `{ action: 'help', error: '...' }`
 *   - Non-`!sb` message               -> `null`
 *
 * @param {string} body
 * @returns {{ action: 'list' | 'play' | 'stop' | 'add' | 'remove' | 'help', clip?: string, replace?: boolean, room?: string, error?: string } | null}
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
    const room = parseInRoom(tokens.slice(2));
    if (room === false) return { action: 'help', error: 'Usage: !sb stop [in <room>]' };
    return room ? { action: 'stop', room } : { action: 'stop' };
  }

  if (sub === 'play') {
    const rawClip = tokens[2];
    const room = parseInRoom(tokens.slice(3));
    if (!rawClip || room === false) {
      return { action: 'help', error: 'Usage: !sb play <clip> [in <room>]' };
    }
    const clip = sanitizeClipName(rawClip);
    if (!clip) {
      return { action: 'help', error: `Invalid clip name: ${rawClip}` };
    }
    return room ? { action: 'play', clip, room } : { action: 'play', clip };
  }

  if (sub === 'add' || sub === 'remove') {
    const flags = tokens.slice(2).filter((t) => t.startsWith('--'));
    const args = tokens.slice(2).filter((t) => !t.startsWith('--'));
    const allowed = sub === 'add' ? ['--replace'] : [];
    const usage =
      sub === 'add'
        ? 'Usage: !sb add <name> [--replace] (as a reply to an audio message)'
        : 'Usage: !sb remove <name>';
    if (args.length !== 1 || flags.some((f) => !allowed.includes(f.toLowerCase()))) {
      return { action: 'help', error: usage };
    }
    const clip = args[0];
    if (!CLIP_NAME_RE.test(clip)) {
      return { action: 'help', error: `Invalid clip name "${clip}": use 1-32 characters from a-z 0-9 _ - and start with a letter or digit` };
    }
    return sub === 'add' ? { action: 'add', clip, replace: flags.length > 0 } : { action: 'remove', clip };
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

/**
 * Parse an optional trailing `in <room name...>` clause.
 * @param {string[]} rest
 * @returns {string | null | false} room text, null if absent, false if malformed
 */
function parseInRoom(rest) {
  if (rest.length === 0) return null;
  if (rest[0].toLowerCase() !== 'in' || rest.length < 2) return false;
  return rest.slice(1).join(' ');
}

/**
 * Strip the legacy reply fallback (`> <@user> quoted...` lines + blank line) that some clients
 * prepend to the body of a reply.
 * @param {string} body
 */
export function stripReplyFallback(body) {
  if (typeof body !== 'string') return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i === 0) return body;
  if (lines[i] === '') i++;
  return lines.slice(i).join('\n');
}
