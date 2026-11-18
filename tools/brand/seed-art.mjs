// Seed art (P4 E3): Space/room avatars, the custom emoji pack and the sticker pack.
// Original artwork in the E2 Squadz palette. Writes the SVG source to assets/art-src/<kind>/
// and the PNG exports bootstrap uploads to assets/{avatars,emoji,stickers}/.
// Usage (from tools/brand, after npm ci): node seed-art.mjs [--gallery <out.png>]
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const assets = join(root, "assets");

// Curated palette: E2 brand (night/ink/violet/mint/paper) plus three warm/cool accents.
const C = {
  ink: "#0B0C19", night: "#1B1D3F", violet: "#7C5CFF", violetD: "#5A3FE0",
  mint: "#2EE6A6", mintD: "#14B886", paper: "#F2F3FF", mist: "#C9CBEA",
  amber: "#FFB547", amberD: "#F08C1A", pink: "#FF5C8A", pinkD: "#D43A68",
  sky: "#4CC9F0", blue: "#2F8FD8", blueD: "#1D66B0",
};
const S = `stroke="${C.ink}" stroke-linejoin="round" stroke-linecap="round"`;

// ---------------------------------------------------------------- shared bits
const eyes = (cx, cy, dx, r = 5.5) =>
  `<ellipse cx="${cx - dx}" cy="${cy}" rx="${r}" ry="${r * 1.25}" fill="${C.ink}"/><ellipse cx="${cx + dx}" cy="${cy}" rx="${r}" ry="${r * 1.25}" fill="${C.ink}"/>`;
const happyEyes = (cx, cy, dx, w = 7, sw = 5) =>
  `<path d="M${cx - dx - w} ${cy + 3}Q${cx - dx} ${cy - 7} ${cx - dx + w} ${cy + 3}M${cx + dx - w} ${cy + 3}Q${cx + dx} ${cy - 7} ${cx + dx + w} ${cy + 3}" fill="none" ${S} stroke-width="${sw}"/>`;
const smile = (cx, cy, w, d, sw = 5) =>
  `<path d="M${cx - w} ${cy}Q${cx} ${cy + d} ${cx + w} ${cy}" fill="none" ${S} stroke-width="${sw}"/>`;
// A squad member: round blob with a face (the brand mark's circles, given a personality).
const blob = (cx, cy, r, fill, face, sw = 6) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${S} stroke-width="${sw}"/>${face}`;
// Bold stroked "G" (wordmark style) centred on cx,cy.
const G = (cx, cy, rx, ry, color, sw) => {
  const a = (deg) => [cx + rx * Math.cos((deg * Math.PI) / 180), cy + ry * Math.sin((deg * Math.PI) / 180)];
  const [sx, sy] = a(-42), [ex, ey] = a(14);
  return `<path d="M${sx.toFixed(1)} ${sy.toFixed(1)}A${rx} ${ry} 0 1 0 ${ex.toFixed(1)} ${ey.toFixed(1)}V${(cy + 2).toFixed(1)}H${(cx + rx * 0.2).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
};
// Coloured limb/line with an ink outline (thick ink stroke under a thinner colour stroke).
const oline = (d, color, w, ow = 6) =>
  `<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${w + ow * 2}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const svg = (size, body, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>\n`;

// ---------------------------------------------------------------- emoji (128)
const emoji = {
  squadz: `<circle cx="45" cy="48" r="25" fill="${C.violet}" ${S} stroke-width="6"/><circle cx="83" cy="48" r="25" fill="${C.paper}" ${S} stroke-width="6"/><circle cx="64" cy="84" r="25" fill="${C.mint}" ${S} stroke-width="6"/>`,
  wave:
    blob(56, 72, 42, C.mint, eyes(56, 64, 14) + smile(56, 82, 15, 12)) +
    `<path d="M96 22q8 4 10 12M108 14q12 6 14 20" fill="none" stroke="${C.violet}" stroke-width="6" stroke-linecap="round"/>` +
    `<circle cx="100" cy="44" r="15" fill="${C.paper}" ${S} stroke-width="6"/>`,
  gg:
    `<rect x="6" y="24" width="116" height="80" rx="26" fill="${C.violet}" ${S} stroke-width="6"/>` +
    G(42, 64, 17, 22, C.paper, 11) + G(87, 64, 17, 22, C.paper, 11),
  party:
    // Paper rim outside the ink outline so the cone edge holds on dark themes.
    `<path d="M12 118L44 40L90 86Z" fill="none" stroke="${C.paper}" stroke-width="14" stroke-linejoin="round"/>` +
    `<path d="M12 118L44 40L90 86Z" fill="${C.amber}" ${S} stroke-width="6"/>` +
    `<path d="M34 66L64 96M22 94L38 110" stroke="${C.pink}" stroke-width="9" stroke-linecap="round"/>` +
    `<path d="M12 118L44 40L90 86Z" fill="none" ${S} stroke-width="6"/>` +
    oline("M60 44q6-20 26-18", C.violet, 8) + oline("M88 64q18-8 28 10", C.mint, 8) +
    `<circle cx="106" cy="24" r="11" fill="${C.mint}" ${S} stroke-width="5"/><circle cx="112" cy="102" r="9" fill="${C.pink}" ${S} stroke-width="5"/><rect x="64" y="2" width="16" height="16" rx="3" transform="rotate(20 72 10)" fill="${C.amber}" ${S} stroke-width="5"/>`,
  hype:
    `<path d="M64 120C30 120 18 94 26 72C32 56 44 50 44 30C60 40 66 54 64 66C72 58 76 46 74 30C98 48 112 76 102 98C96 112 82 120 64 120Z" fill="${C.pink}" ${S} stroke-width="6"/>` +
    `<path d="M64 112C46 112 38 98 42 86C46 76 54 72 56 62C64 70 66 78 66 84C72 80 76 72 78 66C90 78 92 92 86 102C82 108 74 112 64 112Z" fill="${C.amber}"/>` +
    `<path d="M64 108C56 108 52 102 54 96C56 92 60 88 62 84C66 90 70 94 72 98C74 104 70 108 64 108Z" fill="${C.paper}"/>`,
  lol:
    blob(64, 66, 52, C.amber, "") +
    happyEyes(64, 50, 20, 9, 6) +
    `<path d="M36 70H92Q90 102 64 102Q38 102 36 70Z" fill="${C.ink}" ${S} stroke-width="5"/><path d="M50 92Q64 82 78 92Q72 100 64 100Q56 100 50 92Z" fill="${C.pink}"/>` +
    `<path d="M14 46q-10 14 0 22q10-8 0-22ZM114 46q-10 14 0 22q10-8 0-22Z" fill="${C.sky}" ${S} stroke-width="4"/>`,
  rip:
    `<path d="M28 116V54A36 36 0 0 1 100 54V116Z" fill="${C.mist}" ${S} stroke-width="6"/>` +
    `<path d="M64 42V86M50 56H78" stroke="${C.night}" stroke-width="9" stroke-linecap="round"/>` +
    `<path d="M10 118H118" ${S} stroke-width="6"/><path d="M18 116q6-14 12 0M92 116q6-16 14 0" fill="${C.mint}" ${S} stroke-width="4"/>`,
  heart:
    `<path d="M64 114C30 90 10 70 10 46C10 28 24 16 40 16C52 16 60 24 64 32C68 24 76 16 88 16C104 16 118 28 118 46C118 70 98 90 64 114Z" fill="${C.pink}" ${S} stroke-width="6"/>` +
    `<path d="M30 44q2-12 14-14" fill="none" stroke="${C.paper}" stroke-width="7" stroke-linecap="round"/>`,
  hmm:
    blob(68, 56, 48, C.amber, "") +
    `<path d="M40 34L58 30M80 26L98 32" ${S} stroke-width="6"/>` + eyes(68, 46, 19, 6) +
    `<path d="M64 74L92 66" ${S} stroke-width="6"/>` +
    // Classic chin-rest: compact palm at the lower-left chin edge, short thumb tucked left,
    // index finger lying flat along the jaw below the (uncovered) mouth.
    oline("M28 100L22 88", C.amber, 11, 5) +
    `<circle cx="36" cy="106" r="16" fill="${C.amber}" ${S} stroke-width="6"/>` +
    oline("M44 96H72", C.amber, 11, 5),
  // The one surreal piece: a floating eye with a little hover shadow (Hypnospace vibe).
  seen:
    `<ellipse cx="64" cy="118" rx="30" ry="5" fill="${C.violet}" opacity="0.55"/>` +
    oline("M30 28L22 14", C.mint, 7, 4) + oline("M64 16V4", C.mint, 7, 4) + oline("M98 28L106 14", C.mint, 7, 4) +
    `<path d="M8 58Q64 -2 120 58Q64 118 8 58Z" fill="${C.paper}" ${S} stroke-width="6"/>` +
    `<circle cx="64" cy="58" r="24" fill="${C.violet}" ${S} stroke-width="5"/><circle cx="64" cy="58" r="11" fill="${C.ink}"/><circle cx="72" cy="50" r="6" fill="${C.mint}"/>`,
  brb:
    `<circle cx="26" cy="26" r="19" fill="${C.amber}" ${S} stroke-width="6"/><circle cx="102" cy="26" r="19" fill="${C.amber}" ${S} stroke-width="6"/>` +
    `<circle cx="64" cy="68" r="50" fill="${C.paper}" ${S} stroke-width="6"/><circle cx="64" cy="68" r="40" fill="none" stroke="${C.sky}" stroke-width="7"/>` +
    `<path d="M64 68V42M64 68L82 78" ${S} stroke-width="8"/><circle cx="64" cy="68" r="6" fill="${C.ink}"/>`,
  dub:
    oline("M36 32H18Q14 60 42 66", C.amber, 11, 5) + oline("M92 32H110Q114 60 86 66", C.amber, 11, 5) +
    `<path d="M32 18H96V48C96 72 82 84 64 84C46 84 32 72 32 48Z" fill="${C.amber}" ${S} stroke-width="6"/>` +
    `<path d="M50 82H78V100H50Z" fill="${C.amber}" ${S} stroke-width="6"/><rect x="30" y="98" width="68" height="22" rx="6" fill="${C.violet}" ${S} stroke-width="6"/>` +
    `<path d="M64 30L69 41L81 42L72 50L75 62L64 56L53 62L56 50L47 42L59 41Z" fill="${C.paper}" ${S} stroke-width="3"/>`,
};

// ---------------------------------------------------------------- stickers (320)
// Die-cut look: a paper border around the whole silhouette, then a thin night keyline outside
// it so the sticker edge reads on light themes too (both via dilate filters).
const cut = `<filter id="cut" x="-12%" y="-12%" width="124%" height="124%"><feMorphology in="SourceAlpha" operator="dilate" radius="12" result="k"/><feFlood flood-color="${C.night}"/><feComposite in2="k" operator="in" result="ko"/><feMorphology in="SourceAlpha" operator="dilate" radius="9" result="d"/><feFlood flood-color="${C.paper}"/><feComposite in2="d" operator="in" result="o"/><feMerge><feMergeNode in="ko"/><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const sticker = (body) => `<g filter="url(#cut)">${body}</g>`;
const stickers = {
  gg_wp: sticker(
    `<rect x="40" y="196" width="240" height="96" rx="34" fill="${C.violet}" ${S} stroke-width="8"/>` +
      G(124, 244, 22, 28, C.paper, 14) + G(196, 244, 22, 28, C.paper, 14) +
      `<path d="M44 132L22 92M276 132L298 92M120 70L108 34M200 70L212 34" ${S} stroke-width="10"/>` +
      blob(80, 150, 44, C.violet, happyEyes(80, 142, 15) + smile(80, 160, 12, 10)) +
      blob(240, 150, 44, C.mint, happyEyes(240, 142, 15) + smile(240, 160, 12, 10)) +
      blob(160, 118, 48, C.paper, happyEyes(160, 108, 16) + `<path d="M144 126H176Q174 146 160 146Q146 146 144 126Z" fill="${C.ink}" ${S} stroke-width="5"/>`),
  ),
  omw: sticker(
    `<path d="M30 140H90M18 176H80M40 212H96" stroke="${C.violet}" stroke-width="12" stroke-linecap="round"/>` +
      `<path d="M150 236L128 280M196 236L228 270" ${S} stroke-width="14"/>` +
      `<path d="M120 150L92 124M236 150L270 128" ${S} stroke-width="12"/>` +
      blob(178, 168, 76, C.mint, eyes(200, 150, 18, 8) + `<path d="M188 192Q208 206 228 190" fill="none" ${S} stroke-width="7"/>`, 8) +
      `<path d="M226 92q20-10 36 2" fill="none" ${S} stroke-width="7"/>` +
      `<circle cx="64" cy="252" r="16" fill="${C.mist}" ${S} stroke-width="6"/><circle cx="96" cy="270" r="11" fill="${C.mist}" ${S} stroke-width="6"/>`,
  ),
  lets_go: sticker(
    `<path d="M160 30L172 62L206 64L180 86L190 118L160 100L130 118L140 86L114 64L148 62Z" fill="${C.amber}" ${S} stroke-width="7"/>` +
      `<path d="M64 70L82 92M256 70L238 92M40 150H64M256 150H280" ${S} stroke-width="9"/>` +
      oline("M206 176L244 126", C.violet, 26, 7) + `<circle cx="250" cy="112" r="26" fill="${C.violet}" ${S} stroke-width="7"/><path d="M236 104q14-6 28 0" fill="none" ${S} stroke-width="5"/>` +
      oline("M132 262L120 292", C.violet, 18, 7) + oline("M188 262L200 292", C.violet, 18, 7) +
      blob(160, 208, 70, C.violet, happyEyes(160, 192, 24, 11, 7) + `<path d="M132 214H188Q186 250 160 250Q134 250 132 214Z" fill="${C.ink}" ${S} stroke-width="6"/><path d="M146 240Q160 230 174 240Q168 248 160 248Q152 248 146 240Z" fill="${C.pink}"/>`, 8),
  ),
  gn: sticker(
    `<path d="M210 36A118 118 0 1 0 290 214A96 96 0 1 1 210 36Z" fill="${C.amber}" ${S} stroke-width="8"/>` +
      `<path d="M112 168q10 10 20 0M150 196q14 12 28 0" fill="none" ${S} stroke-width="7"/>` +
      blob(196, 238, 52, C.paper, `<path d="M174 236q8 6 16 0M204 236q8 6 16 0" fill="none" ${S} stroke-width="6"/><ellipse cx="198" cy="258" rx="7" ry="5" fill="${C.ink}"/>`, 8) +
      `<path d="M236 60H262L236 90H262M274 110H292L274 132H292" fill="none" stroke="${C.violet}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M60 70l5 12l12 2l-9 8l3 12l-11-6l-11 6l3-12l-9-8l12-2Z" fill="${C.mint}" ${S} stroke-width="5"/>`,
  ),
};

// ---------------------------------------------------------------- avatars (256)
// Full-bleed square (clients crop to circle or squircle); glyph sits inside the circle-safe 64%.
const grad = (a, b) => `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const tile = (a, b, body) => svg(256, `<rect width="256" height="256" fill="url(#bg)"/>${body}`, grad(a, b));
const P = C.paper, N = C.night;
const avatars = {
  squadz: readFileSync(join(assets, "brand", "squadz-mark.svg"), "utf8"),
  general: tile(C.violet, C.violetD,
    `<path d="M64 76Q64 58 82 58H174Q192 58 192 76V146Q192 164 174 164H118L84 196V164H82Q64 164 64 146Z" fill="${P}"/>` +
      `<circle cx="96" cy="111" r="11" fill="${C.violet}"/><circle cx="128" cy="111" r="11" fill="${C.violet}"/><circle cx="160" cy="111" r="11" fill="${C.violet}"/>`),
  games: tile(C.mint, C.mintD,
    `<path d="M88 82H168C196 82 212 110 214 146C216 178 196 188 182 172L160 150H96L74 172C60 188 40 178 42 146C44 110 60 82 88 82Z" fill="${N}"/>` +
      `<path d="M86 106V134M72 120H100" stroke="${C.mint}" stroke-width="10" stroke-linecap="round"/><circle cx="166" cy="110" r="9" fill="${C.amber}"/><circle cx="184" cy="130" r="9" fill="${C.pink}"/>`),
  clips: tile(C.pink, C.pinkD,
    `<rect x="56" y="72" width="144" height="112" rx="24" fill="${P}"/>` +
      `<path d="M112 100L156 128L112 156Z" fill="${C.pink}" stroke="${C.pink}" stroke-width="8" stroke-linejoin="round"/>` +
      `<path d="M78 58L98 72M128 52V72M178 58L158 72" stroke="${P}" stroke-width="10" stroke-linecap="round"/>`),
  memes: tile(C.amber, C.amberD,
    `<circle cx="128" cy="132" r="70" fill="${P}"/>` +
      `<path d="M88 118Q100 100 112 118M144 118Q156 100 168 118" fill="none" stroke="${N}" stroke-width="10" stroke-linecap="round"/>` +
      `<path d="M90 140H166Q164 182 128 182Q92 182 90 140Z" fill="${N}"/><path d="M108 170Q128 156 148 170Q140 180 128 180Q116 180 108 170Z" fill="${C.pink}"/>`),
  lounge: tile(C.blue, C.blueD,
    `<path d="M64 158V132A64 64 0 0 1 192 132V158" fill="none" stroke="${P}" stroke-width="18" stroke-linecap="round"/>` +
      `<rect x="54" y="138" width="40" height="62" rx="16" fill="${P}"/><rect x="162" y="138" width="40" height="62" rx="16" fill="${P}"/>` +
      `<path d="M112 160q8-10 0-20M144 160q-8-10 0-20" fill="none" stroke="${C.sky}" stroke-width="8" stroke-linecap="round"/>`),
  "game-night": tile("#2B2E66", C.ink,
    `<path d="M132 36A80 80 0 1 0 190 160A62 62 0 1 1 132 36Z" fill="${C.amber}"/>` +
      `<path d="M190 54l5 12l12 2l-9 8l3 12l-11-6l-11 6l3-12l-9-8l12-2Z" fill="${C.mint}"/><circle cx="214" cy="112" r="5" fill="${P}"/><circle cx="62" cy="200" r="5" fill="${P}"/>` +
      // Gamepad tilted across the moon's lower edge, keylined so it separates from the crescent.
      `<g transform="rotate(-14 160 182)"><path d="M130 154H190C208 154 218 172 218 194C218 212 204 216 194 206L182 194H138L126 206C116 216 102 212 102 194C102 172 112 154 130 154Z" fill="${C.violet}" stroke="${C.ink}" stroke-width="8" stroke-linejoin="round"/>` +
      `<path d="M134 164V188M122 176H146" stroke="${P}" stroke-width="8" stroke-linecap="round"/><circle cx="180" cy="170" r="7" fill="${C.mint}"/><circle cx="196" cy="184" r="7" fill="${C.pink}"/></g>`),
};

// ---------------------------------------------------------------- export
const render = (s, width) => new Resvg(s, { fitTo: { mode: "width", value: width } }).render().asPng();
const kinds = [
  ["emoji", emoji, 128, (b) => svg(128, b)],
  ["stickers", stickers, 320, (b) => svg(320, b, cut)],
  ["avatars", avatars, 256, (b) => b],
];
const out = [];
for (const [kind, set, size, wrap] of kinds) {
  mkdirSync(join(assets, "art-src", kind), { recursive: true });
  mkdirSync(join(assets, kind), { recursive: true });
  for (const [name, body] of Object.entries(set)) {
    const src = wrap(body);
    writeFileSync(join(assets, "art-src", kind, `${name}.svg`), src);
    // The brand mark's glow gradient compresses poorly: 192px keeps the Space icon under 30KB.
    const png = render(src, kind === "avatars" && name === "squadz" ? 192 : size);
    writeFileSync(join(assets, kind, `${name}.png`), png);
    out.push({ kind, name, src, size, bytes: png.length });
  }
}
for (const o of out) console.log(`${o.kind}/${o.name}.png ${o.size}px ${(o.bytes / 1024).toFixed(1)}KB`);

// Review gallery (not committed): every asset at 4x of its 32px render (pixelated, the real
// sidebar/inline size) next to a full-size render, on dark and light chat backgrounds.
const gi = process.argv.indexOf("--gallery");
if (gi > 0) {
  const cell = 150, cols = 8;
  const rows = Math.ceil(out.length / cols);
  const parts = [];
  out.forEach((o, i) => {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * cell * 2;
    const small = render(o.src, 32).toString("base64");
    const big = render(o.src, 128).toString("base64");
    const round = o.kind === "avatars" ? `clip-path="url(#circ${i})"` : "";
    parts.push(
      `<clipPath id="circ${i}"><circle cx="${x + 75}" cy="${y + 75}" r="64"/></clipPath>` +
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="#0E0F22"/><rect x="${x}" y="${y + cell}" width="${cell}" height="${cell}" fill="#F2F3FF"/>` +
        `<image x="${x + 11}" y="${y + 11}" width="128" height="128" href="data:image/png;base64,${big}" ${round}/>` +
        `<image x="${x + 11}" y="${y + cell + 11}" width="128" height="128" image-rendering="optimizeSpeed" href="data:image/png;base64,${small}"/>` +
        `<image x="${x + 4}" y="${y + 4}" width="32" height="32" href="data:image/png;base64,${small}"/>`,
    );
  });
  const g = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell * 2}">${parts.join("")}</svg>`;
  writeFileSync(process.argv[gi + 1], new Resvg(g).render().asPng());
  console.log(`gallery -> ${process.argv[gi + 1]}`);
}
