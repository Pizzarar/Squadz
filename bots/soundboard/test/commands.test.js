import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, sanitizeClipName } from '../src/commands.js';

describe('parseCommand', () => {
  it('returns null for non-soundboard messages', () => {
    assert.equal(parseCommand('hello world'), null);
    assert.equal(parseCommand('!other list'), null);
    assert.equal(parseCommand('!sblist'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand('   '), null);
    assert.equal(parseCommand(null), null);
  });

  it('parses !sb and !sb list', () => {
    assert.deepEqual(parseCommand('!sb'), { action: 'list' });
    assert.deepEqual(parseCommand('  !sb   list  '), { action: 'list' });
    assert.deepEqual(parseCommand('!sb LIST'), { action: 'list' });
    assert.deepEqual(parseCommand('!sb help'), { action: 'list' });
  });

  it('parses !sb play <clip>', () => {
    assert.deepEqual(parseCommand('!sb play beep'), { action: 'play', clip: 'beep' });
    assert.deepEqual(parseCommand('!sb PLAY AirHorn.mp3'), { action: 'play', clip: 'airhorn' });
    assert.deepEqual(parseCommand('!sb play rim-shot_1.ogg'), { action: 'play', clip: 'rim-shot_1' });
  });

  it('parses !sb stop', () => {
    assert.deepEqual(parseCommand('!sb stop'), { action: 'stop' });
    assert.deepEqual(parseCommand('!sb STOP'), { action: 'stop' });
  });

  it('rejects malformed or path-traversal clip names and unknown subcommands', () => {
    const missingClip = parseCommand('!sb play');
    assert.equal(missingClip.action, 'help');
    assert.match(missingClip.error, /Usage/);

    const extraArgs = parseCommand('!sb play one two');
    assert.equal(extraArgs.action, 'help');

    const traversal = parseCommand('!sb play ../etc/passwd');
    assert.equal(traversal.action, 'help');
    assert.match(traversal.error, /Invalid clip name/);

    const unknown = parseCommand('!sb dance');
    assert.equal(unknown.action, 'help');
    assert.match(unknown.error, /Unknown subcommand/);
  });

  it('sanitizeClipName strips extensions and rejects unsafe names', () => {
    assert.equal(sanitizeClipName('beep.wav'), 'beep');
    assert.equal(sanitizeClipName('GG_WP.MP3'), 'gg_wp');
    assert.equal(sanitizeClipName('../secret'), null);
    assert.equal(sanitizeClipName('-leading-dash'), null);
    assert.equal(sanitizeClipName('a/b'), null);
  });
});
