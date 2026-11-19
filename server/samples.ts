/**
 * Deterministic, program-generated sample assets.
 *
 * The set deliberately covers what the requirements call out: irregular
 * transparent shapes, a fully transparent frame, different canvas sizes,
 * long strips that benefit from packing rotation, and two different files
 * with the same basename in different folders.
 *
 * Everything is seeded math, never Math.random(), so exports are reproducible.
 */

import sharp from 'sharp';

export interface GeneratedSample {
  /** Relative path used as the frame's source scope. */
  key: string;
  png: Buffer;
}

interface Canvas {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

function canvas(
  width: number,
  height: number,
  paint: (w: number, h: number, put: (x: number, y: number, r: number, g: number, b: number, a: number) => void) => void,
): Canvas {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const putAt = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    pixels[o] = r;
    pixels[o + 1] = g;
    pixels[o + 2] = b;
    pixels[o + 3] = a;
  };
  paint(width, height, putAt);
  return { width, height, pixels };
}

async function encode(surface: Canvas): Promise<Buffer> {
  return sharp(Buffer.from(surface.pixels), {
    raw: { width: surface.width, height: surface.height, channels: 4 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

function blob(cx: number, cy: number, rx: number, ry: number, spin: number) {
  return (x: number, y: number): number | null => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    const angle = Math.atan2(dy, dx);
    const wobble = 1 + 0.22 * Math.sin(angle * 3 + spin) + 0.1 * Math.cos(angle * 5 - spin * 2);
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > wobble) return null;
    // Antialiased edge (half pixel feather).
    const edge = Math.min(1, Math.max(0, (wobble - r) * 6));
    return edge;
  };
}

function hero(frame: number, tint: [number, number, number]): Canvas {
  const width = 64;
  const height = 96;
  // Same canvas for every hero frame; only the shape moves. Anchors therefore
  // line up without any per-frame correction.
  const body = blob(26 + frame * 3, 58 - frame, 16, 22, frame * 0.9);
  const limb = blob(38 + frame * 2, 34 + frame * 2, 7, 13, frame);
  return canvas(width, height, (_w, _h, put) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a1 = body(x, y);
        const a2 = limb(x, y);
        const alpha = Math.max(a1 ?? 0, a2 ?? 0);
        if (alpha <= 0) continue;
        const shade = 0.65 + 0.35 * Math.sin((x + y + frame * 7) * 0.2);
        put(
          x,
          y,
          Math.round(tint[0] * shade),
          Math.round(tint[1] * shade),
          Math.round(tint[2] * shade),
          Math.round(alpha * 255),
        );
      }
    }
  });
}

export async function generateSamples(): Promise<GeneratedSample[]> {
  const out: GeneratedSample[] = [];
  const push = async (key: string, surface: Canvas) => {
    out.push({ key, png: await encode(surface) });
  };

  await push('characters/hero_idle.png', hero(0, [226, 108, 84]));
  await push('characters/hero_run_1.png', hero(1, [226, 108, 84]));
  await push('characters/hero_run_2.png', hero(2, [226, 108, 84]));
  await push('characters/hero_run_3.png', hero(3, [226, 108, 84]));

  // Same basename as characters/hero_idle.png but a different directory and
  // different pixels: must remain a separate frame.
  await push('alternate/hero_idle.png', hero(0, [72, 126, 214]));

  // Fully transparent frame: kept, exportable, and still addressable.
  await push(
    'ui/empty_placeholder.png',
    canvas(32, 40, (_w, _h, _put) => {
      /* intentionally empty */
    }),
  );

  // Irregular slash with soft (semi-transparent) edges and color underneath
  // fully transparent pixels, to exercise the documented ignore rule.
  await push(
    'effects/slash.png',
    canvas(128, 64, (_w, _h, put) => {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 128; x++) {
          const t = x / 127;
          const center = 20 + t * 32;
          const dist = Math.abs(y - center - Math.sin(t * Math.PI * 2) * 6);
          const thickness = 2 + 9 * Math.sin(t * Math.PI);
          if (x === 0 && y === 0) {
            // RGB under alpha 0: invisible, allowed to differ after round trip.
            put(x, y, 255, 0, 255, 0);
            continue;
          }
          if (dist > thickness) continue;
          const alpha = Math.round(255 * Math.max(0, 1 - dist / thickness));
          put(x, y, 255, 220 - Math.round(t * 120), 120, alpha);
        }
      }
    }),
  );

  // Hollow UI frame: transparent interior, so trimming keeps original size.
  await push(
    'ui/hollow_frame.png',
    canvas(50, 50, (w, h, put) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const edge = x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
          if (!edge) continue;
          const alpha = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 180 : 255;
          put(x, y, 250, 240, 210, alpha);
        }
      }
    }),
  );

  // Long strips: ideal candidates for 90-degree packing rotation.
  await push(
    'strips/tall_banner.png',
    canvas(16, 300, (_w, _h, put) => {
      for (let y = 0; y < 300; y++) {
        for (let x = 0; x < 16; x++) {
          if (x === 0 || x === 15) continue;
          const a = Math.round(120 + 135 * Math.sin(y * 0.11));
          put(x, y, 90, 200, 255, a);
        }
      }
    }),
  );
  await push(
    'strips/wide_banner.png',
    canvas(260, 14, (_w, _h, put) => {
      for (let x = 0; x < 260; x++) {
        for (let y = 0; y < 14; y++) {
          if (y === 0 || y === 13) continue;
          put(x, y, 255, 180, 90, 200);
        }
      }
    }),
  );

  // Tiny dot at an off-center position: checks integer trim offsets.
  await push(
    'characters/tiny_dot.png',
    canvas(8, 8, (_w, _h, put) => {
      put(3, 5, 20, 240, 200, 255);
      put(4, 5, 20, 240, 200, 160);
    }),
  );

  // A large frame, used to demonstrate FRAME_TOO_LARGE with small pages.
  await push(
    'backgrounds/big_ring.png',
    canvas(220, 220, (w, h, put) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - 110;
          const dy = y - 110;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r < 70 || r > 100) continue;
          put(x, y, 60, 70, 120, 255);
        }
      }
    }),
  );

  return out;
}
