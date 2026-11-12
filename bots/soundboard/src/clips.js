// Clip registry: indexes audio clips (.mp3, .ogg, .wav) from SOUNDBOARD_CLIPS_DIR.
import { readdirSync, statSync } from 'node:fs';
import { extname, basename, resolve, sep } from 'node:path';
import { sanitizeClipName } from './commands.js';

export const ALLOWED_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav']);
// Deterministic priority when multiple files share a stem (.wav > .ogg > .mp3).
const EXT_PRIORITY = ['.wav', '.ogg', '.mp3'];

/**
 * Scan `clipsDir` (non-recursively) and return a Map of `clipName -> absoluteFilePath`.
 *
 * @param {string} clipsDir
 * @returns {Map<string, string>}
 */
export function loadClips(clipsDir) {
  const root = resolve(clipsDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    throw err;
  }

  /** @type {Map<string, { ext: string, fullPath: string }>} */
  const found = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;

    const stem = basename(entry.name, extname(entry.name));
    const name = sanitizeClipName(stem);
    if (!name) continue;

    const fullPath = resolve(root, entry.name);
    // Guard against path escape
    if (!fullPath.startsWith(root + sep) && fullPath !== root) continue;

    try {
      const st = statSync(fullPath);
      if (!st.isFile() || st.size <= 0) continue;
    } catch {
      continue;
    }

    const existing = found.get(name);
    if (
      !existing ||
      EXT_PRIORITY.indexOf(ext) < EXT_PRIORITY.indexOf(existing.ext)
    ) {
      found.set(name, { ext, fullPath });
    }
  }

  const sortedNames = [...found.keys()].sort();
  const result = new Map();
  for (const name of sortedNames) {
    result.set(name, found.get(name).fullPath);
  }
  return result;
}

/**
 * Stateful clip registry wrapper that rescans on demand.
 */
export class ClipRegistry {
  /**
   * @param {string} clipsDir
   */
  constructor(clipsDir) {
    this.clipsDir = resolve(clipsDir);
  }

  /**
   * Return sorted list of available clip names.
   * @returns {string[]}
   */
  list() {
    return [...loadClips(this.clipsDir).keys()];
  }

  /**
   * Resolve a clip name to an absolute path inside `clipsDir`, or `null` if not found.
   * @param {string} rawName
   * @returns {string | null}
   */
  resolve(rawName) {
    const clean = sanitizeClipName(rawName);
    if (!clean) return null;
    const clips = loadClips(this.clipsDir);
    return clips.get(clean) ?? null;
  }
}
