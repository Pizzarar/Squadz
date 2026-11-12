import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomName, resolveVoiceRoom } from '../src/rooms.js';
import { parseCommand } from '../src/commands.js';

const L = { roomId: '!l:x', names: ['Lounge', '#lounge:x'], activeCall: true };
const G = { roomId: '!g:x', names: ['Game Night', '#game-night:x'], activeCall: false };

describe('resolveVoiceRoom', () => {
  it('normalises names and aliases', () => {
    assert.equal(normalizeRoomName('#Game-Night:chat.x'), 'game night');
    assert.equal(normalizeRoomName('  Game   Night '), 'game night');
  });
  it('matches explicit names, aliases and room IDs', () => {
    assert.deepEqual(resolveVoiceRoom({ requested: 'lounge', candidates: [L, G] }), { roomId: '!l:x' });
    assert.deepEqual(resolveVoiceRoom({ requested: '!l:x', candidates: [L, G] }), { roomId: '!l:x' });
    assert.equal(resolveVoiceRoom({ requested: 'game-night', candidates: [L, G] }).error, 'no-active-call');
    assert.equal(resolveVoiceRoom({ requested: 'zzz', candidates: [L, G] }).error, 'unknown');
  });
  it('falls back to the single active call, else asks', () => {
    assert.deepEqual(resolveVoiceRoom({ candidates: [L, G] }), { roomId: '!l:x' });
    assert.equal(resolveVoiceRoom({ candidates: [G] }).error, 'no-active-call');
    assert.equal(resolveVoiceRoom({ candidates: [L, { ...G, activeCall: true }] }).error, 'ambiguous');
  });
});

describe('parseCommand `in <room>`', () => {
  it('parses play/stop with a room', () => {
    assert.deepEqual(parseCommand('!sb play beep in Game Night'), { action: 'play', clip: 'beep', room: 'Game Night' });
    assert.deepEqual(parseCommand('!sb stop in lounge'), { action: 'stop', room: 'lounge' });
    assert.equal(parseCommand('!sb play beep on lounge').action, 'help');
    assert.equal(parseCommand('!sb play beep in').action, 'help');
  });
});
