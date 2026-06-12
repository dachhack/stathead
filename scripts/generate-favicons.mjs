// Render the PNG favicon fallbacks from the SVG source. Safari (macOS and
// iOS) ignores SVG favicons entirely, so the PNGs are what it actually
// loads; apple-touch-icon is the iOS home-screen icon.
//
// Run after editing src/assets/favicon.svg:
//   npm i --no-save sharp && node scripts/generate-favicons.mjs
//
// sharp is intentionally not a devDependency — it's a ~30MB native binary
// needed only for this occasional regeneration.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets');
const svg = await readFile(path.join(assets, 'favicon.svg'));

const targets = [
  { file: 'favicon-32.png', size: 32 },
  { file: 'apple-touch-icon.png', size: 180 },
];

for (const { file, size } of targets) {
  // density scales the SVG rasterization so small sizes stay crisp.
  const out = path.join(assets, file);
  await sharp(svg, { density: Math.max(72, (size / 64) * 72 * 2) })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`wrote ${out} (${size}x${size})`);
}
