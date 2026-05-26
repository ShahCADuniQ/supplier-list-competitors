// One-shot transform of the CADuniQ logo PNG so it can sit on any
// background — light or dark — without a white card behind it.
//
// Reads:  public/caduniq-logo.png            (original, opaque white BG)
// Writes: public/caduniq-logo.png            (white BG → transparent)
//         public/caduniq-logo-dark.png       (white BG → transparent +
//                                             dark navy text recoloured
//                                             near-white for dark-theme
//                                             surfaces)
//
// Heuristics: a pixel is "white background" if R, G, B are all >= 240.
// A pixel is "dark navy text" if R, G, B are all <= 70. Anything in
// between (the purple/orange gradient gauge + dividers) is left alone
// so the brand colours survive on both themes.

import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "public", "caduniq-logo.png");
const OUT_LIGHT = SRC;
const OUT_DARK = resolve(__dirname, "..", "public", "caduniq-logo-dark.png");

const WHITE_THRESHOLD = 240;
const DARK_THRESHOLD = 70;

async function process() {
  const original = await readFile(SRC);
  const img = sharp(original).ensureAlpha();
  const { data, info } = await img
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels !== 4) {
    throw new Error(`expected RGBA, got ${channels} channels`);
  }

  const light = Buffer.from(data);
  const dark = Buffer.from(data);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Knock out the white background on both variants.
    if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) {
      light[i + 3] = 0;
      dark[i + 3] = 0;
      continue;
    }

    // Dark-mode variant: dark navy text → near-white so it shows on
    // dark surfaces. Gradient pixels (saturated purples / oranges) are
    // left alone since they already pop on dark.
    if (r <= DARK_THRESHOLD && g <= DARK_THRESHOLD && b <= DARK_THRESHOLD) {
      dark[i] = 240;
      dark[i + 1] = 240;
      dark[i + 2] = 245;
    }
  }

  await sharp(light, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(OUT_LIGHT);
  await sharp(dark, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(OUT_DARK);

  console.log(`Wrote ${OUT_LIGHT}`);
  console.log(`Wrote ${OUT_DARK}`);
}

process().catch((e) => {
  console.error(e);
  process.exit(1);
});
