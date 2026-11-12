import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClipRegistry, loadClips } from '../src/clips.js';

describe('ClipRegistry', () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'squadz-sb-clips-'));
    writeFileSync(join(tempDir, 'airhorn.mp3'), Buffer.from('fake-mp3'));
    writeFileSync(join(tempDir, 'drumroll.ogg'), Buffer.from('fake-ogg'));
    writeFileSync(join(tempDir, 'victory.wav'), Buffer.from('fake-wav'));
    // Duplicate stem with lower priority extension (.mp3 vs .wav)
    writeFileSync(join(tempDir, 'victory.mp3'), Buffer.from('fake-mp3-2'));
    // Empty file should be ignored
    writeFileSync(join(tempDir, 'empty.wav'), Buffer.alloc(0));
    // Unsupported extension should be ignored
    writeFileSync(join(tempDir, 'notes.txt'), Buffer.from('ignore me'));
    // Subdirectory should be ignored
    mkdirSync(join(tempDir, 'nested.wav'));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists valid clips sorted alphabetically and prefers .wav over .mp3 on collision', () => {
    const reg = new ClipRegistry(tempDir);
    assert.deepEqual(reg.list(), ['airhorn', 'drumroll', 'victory']);
    assert.equal(reg.resolve('victory'), join(tempDir, 'victory.wav'));
    assert.equal(reg.resolve('AIRHORN.mp3'), join(tempDir, 'airhorn.mp3'));
  });

  it('returns null for missing or traversal clip requests', () => {
    const reg = new ClipRegistry(tempDir);
    assert.equal(reg.resolve('nonexistent'), null);
    assert.equal(reg.resolve('../package.json'), null);
    assert.equal(reg.resolve('notes'), null);
    assert.equal(reg.resolve('empty'), null);
  });

  it('returns empty map when clips directory does not exist', () => {
    const missing = join(tempDir, 'does-not-exist');
    assert.equal(loadClips(missing).size, 0);
  });

  it('finds the bundled beep.wav test clip in bots/soundboard/clips', () => {
    const bundledDir = fileURLToPath(new URL('../clips', import.meta.url));
    const reg = new ClipRegistry(bundledDir);
    assert.ok(reg.list().includes('beep'));
    assert.equal(reg.resolve('beep'), resolve(bundledDir, 'beep.wav'));
  });
});
