// Rasterize assets/brand SVGs to PNG. Usage: node export-png.mjs (from tools/brand, after npm ci)
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "brand");
const render = (svg, width, background) => new Resvg(svg, { fitTo: { mode: "width", value: width }, background }).render().asPng();
const mark = readFileSync(join(dir, "squadz-mark.svg"), "utf8");
for (const n of [16, 32, 180, 192, 512]) {
  writeFileSync(join(dir, `squadz-mark-${n}.png`), render(mark, n));
}
// Preview: logo (mark + wordmark) on a dark card.
const logo = readFileSync(join(dir, "squadz-logo.svg"), "utf8");
writeFileSync(join(dir, "squadz-logo-preview.png"), render(logo, 880, "#0B0C19"));
console.log("ok");

// Copy what the Caddy image bakes in (its build context is ./caddy) next to the Dockerfile.
import { copyFileSync, mkdirSync } from "node:fs";
const out = join(dir, "..", "..", "caddy", "brand");
mkdirSync(out, { recursive: true });
for (const n of [16, 32, 180, 192, 512]) copyFileSync(join(dir, `squadz-mark-${n}.png`), join(out, `icon-${n}.png`));
copyFileSync(join(dir, "squadz-mark.svg"), join(out, "icon.svg"));
// And the Go-Live page (served from web/golive).
const gl = join(dir, "..", "..", "web", "golive", "brand");
mkdirSync(gl, { recursive: true });
copyFileSync(join(dir, "squadz-mark.svg"), join(gl, "squadz-mark.svg"));
copyFileSync(join(dir, "squadz-mark-32.png"), join(gl, "favicon-32.png"));
