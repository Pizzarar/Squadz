// Soundboard uploads: validate audio bytes, parse mxc URIs and save/remove clips on disk.
import { mkdirSync, readdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_CLIP_BYTES = 1024 * 1024; // 1 MB
export const MAX_CLIP_SECONDS = 15;
export const MOD_POWER_LEVEL = 50;
export const CLIP_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const CLIP_EXTS = ['.mp3', '.ogg', '.wav'];

/**
 * Identify audio by magic bytes (never by mimetype). Only mp3, ogg/opus and wav are allowed.
 * @param {Buffer} buf
 * @returns {{ ext: '.mp3' | '.ogg' | '.wav', kind: string } | null}
 */
export function detectAudioFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') {
    return { ext: '.wav', kind: 'wav' };
  }
  if (buf.toString('latin1', 0, 4) === 'OggS') {
    // Opus-in-Ogg: the first page carries the "OpusHead" identification header.
    if (buf.subarray(0, Math.min(buf.length, 128)).includes('OpusHead')) return { ext: '.ogg', kind: 'ogg/opus' };
    return null;
  }
  if (buf.toString('latin1', 0, 3) === 'ID3') return { ext: '.mp3', kind: 'mp3' };
  // Bare MPEG audio frame: 11-bit sync, layer bits != 00, version bits != 01.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0x00 && (buf[1] & 0x18) !== 0x08) {
    return { ext: '.mp3', kind: 'mp3' };
  }
  return null;
}

/** @returns {{ server: string, mediaId: string } | null} */
export function parseMxc(uri) {
  if (typeof uri !== 'string') return null;
  const m = /^mxc:\/\/([^/\s]+)\/([A-Za-z0-9_-]+)$/.exec(uri);
  return m ? { server: m[1], mediaId: m[2] } : null;
}

/** Existing files in `dir` whose stem is `name` (any clip extension). */
export function findClipFiles(dir, name) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        CLIP_EXTS.includes(extname(e.name).toLowerCase()) &&
        basename(e.name, extname(e.name)).toLowerCase() === name
    )
    .map((e) => join(dir, e.name));
}

/**
 * Save a clip atomically (temp file in the same dir, then rename). `validate(tmpPath)` runs on
 * the temp file before it becomes visible and may throw to reject. With `replace`, files for the
 * same name under other extensions are removed so the new clip is not shadowed.
 *
 * @returns {Promise<string>} final path
 */
export async function saveClipAtomic(dir, name, buf, ext, { replace = false, validate } = {}) {
  if (!CLIP_NAME_RE.test(name)) throw new Error(`invalid clip name: ${name}`);
  if (!CLIP_EXTS.includes(ext)) throw new Error(`invalid extension: ${ext}`);
  mkdirSync(dir, { recursive: true });
  const old = findClipFiles(dir, name);
  if (old.length > 0 && !replace) {
    const err = new Error(`clip "${name}" already exists`);
    err.code = 'EEXISTS';
    throw err;
  }
  const finalPath = join(dir, `${name}${ext}`);
  // `.tmp` is not a clip extension, so a half-written file is never listed or played.
  const tmpPath = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, buf, { mode: 0o644 });
    if (validate) await validate(tmpPath);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
  for (const p of old) {
    if (p !== finalPath) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
  return finalPath;
}

/** Delete every file for clip `name`. @returns {number} files removed */
export function removeClipFiles(dir, name) {
  const files = findClipFiles(dir, name);
  for (const f of files) unlinkSync(f);
  return files.length;
}

/**
 * Effective power level of `userId` from m.room.power_levels content and the m.room.create
 * event. Room v12+ creators are implicitly infinite.
 */
export function powerLevelOf(userId, powerLevelsContent, createEvent) {
  const ver = Number.parseInt(createEvent?.content?.room_version ?? '', 10);
  if (createEvent && Number.isFinite(ver) && ver >= 12) {
    if (createEvent.sender === userId) return Infinity;
    if (createEvent.content?.additional_creators?.includes?.(userId)) return Infinity;
  }
  if (!powerLevelsContent) return createEvent?.sender === userId ? 100 : 0;
  const n = Number(powerLevelsContent.users?.[userId] ?? powerLevelsContent.users_default ?? 0);
  return Number.isFinite(n) ? n : 0;
}
