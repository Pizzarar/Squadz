// Generates clips/beep.wav: a 0.4 s 880 Hz sine (mono, 16-bit, 48 kHz) with short fades. Self-made, no third-party audio.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sineWav } from '../src/wav.js';

const out = fileURLToPath(new URL('../clips/beep.wav', import.meta.url));
writeFileSync(out, sineWav({ freq: 880, seconds: 0.4, rate: 48000 }));
console.log('wrote', out);
