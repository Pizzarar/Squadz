// Voice-room resolution for `!sb play <clip> [in <room>]`.
// Commands are read only in the unencrypted #clips room, so the target voice room is picked from
// the Space's rooms: explicit name/alias, else the single room with an active call, else ask.

/** Normalise a room name/alias for matching: `#Game-Night:chat.x` -> `game night`. */
export function normalizeRoomName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/:.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @typedef {{ roomId: string, names: string[], activeCall: boolean }} VoiceCandidate
 * @param {object} args
 * @param {string | undefined} args.requested   text after `in`, if given
 * @param {VoiceCandidate[]} args.candidates
 * @returns {{ roomId: string } | { error: 'unknown' | 'no-active-call' | 'ambiguous', options: VoiceCandidate[] }}
 */
export function resolveVoiceRoom({ requested, candidates }) {
  if (requested) {
    const want = normalizeRoomName(requested);
    const matches = candidates.filter(
      (c) => c.roomId === requested || c.names.some((n) => normalizeRoomName(n) === want)
    );
    if (matches.length === 1) {
      return matches[0].activeCall
        ? { roomId: matches[0].roomId }
        : { error: 'no-active-call', options: matches };
    }
    return { error: matches.length === 0 ? 'unknown' : 'ambiguous', options: matches };
  }
  const active = candidates.filter((c) => c.activeCall);
  if (active.length === 1) return { roomId: active[0].roomId };
  return { error: active.length === 0 ? 'no-active-call' : 'ambiguous', options: active };
}
