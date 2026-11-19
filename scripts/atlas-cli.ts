/**
 * Headless end-to-end pipeline: import PNGs -> pack -> export -> reload the
 * exported files and verify the animation can be reconstructed from them.
 *
 * Usage:
 *   npm run cli -- --out ./out --width 512 --height 512 --samples
 *   npm run cli -- --out ./out --width 256 --height 256 --input ./my-frames
 *
 * Exit code 0 means: every structural check passed, every frame's exported
 * pixels match its original canvas (only RGB under alpha 0 is ignored), and
 * the reloaded bundle (atlas.json + pages/*.png + animation.json) is
 * self-consistent.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AtlasService } from '../server/service';
import { DEFAULT_SETTINGS, type AnimationSpec, type PackSettings } from '../shared/types';
import { ANIMATION_FORMAT } from '../shared/types';
import { verifyBundle } from '../server/bundle';
import { reconstructFrame } from '../shared/reconstruct';
import { compareImages } from '../shared/pixels';

interface Args {
  out: string;
  width: number;
  height: number;
  spacing: number;
  margin: number;
  extrude: number;
  rotate: boolean;
  samples: boolean;
  input?: string;
  animation: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: path.resolve('out'),
    width: DEFAULT_SETTINGS.pageWidth,
    height: DEFAULT_SETTINGS.pageHeight,
    spacing: DEFAULT_SETTINGS.spacing,
    margin: DEFAULT_SETTINGS.margin,
    extrude: DEFAULT_SETTINGS.extrude,
    rotate: DEFAULT_SETTINGS.allowRotation,
    samples: false,
    animation: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--out':
        args.out = path.resolve(next());
        break;
      case '--width':
        args.width = Number(next());
        break;
      case '--height':
        args.height = Number(next());
        break;
      case '--spacing':
        args.spacing = Number(next());
        break;
      case '--margin':
        args.margin = Number(next());
        break;
      case '--extrude':
        args.extrude = Number(next());
        break;
      case '--no-rotate':
        args.rotate = false;
        break;
      case '--samples':
        args.samples = true;
        break;
      case '--input':
        args.input = path.resolve(next());
        break;
      case '--no-animation':
        args.animation = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag ${arg}. Use --help.`);
        }
    }
  }
  if (!args.samples && !args.input) args.samples = true;
  return args;
}

function printHelp() {
  console.log(`sprite atlas CLI

  --out <dir>        output directory (default ./out)
  --width <px>       page width, also the maximum (default 1024)
  --height <px>      page height, also the maximum (default 1024)
  --spacing <px>     empty gap between frame slots (default 2)
  --margin <px>      empty page border (default 4)
  --extrude <px>     edge replication per side (default 1)
  --no-rotate        disable 90-degree packing rotation
  --samples          use the built-in generated samples (default when no --input)
  --input <dir>      import every .png in this directory (recursively)
  --no-animation     export an empty animation
`);
}

async function listPngs(root: string): Promise<{ key: string; bytes: Buffer }[]> {
  const out: { key: string; bytes: Buffer }[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.toLowerCase().endsWith('.png')) {
        out.push({ key: path.relative(root, full).split(path.sep).join('/'), bytes: await fs.readFile(full) });
      }
    }
  };
  await walk(root);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const service = new AtlasService();
  const settings: PackSettings = {
    pageWidth: args.width,
    pageHeight: args.height,
    spacing: args.spacing,
    margin: args.margin,
    extrude: args.extrude,
    allowRotation: args.rotate,
  };

  if (args.samples) {
    const imported = await service.loadSamples();
    console.log(`imported ${imported.frames.length} generated sample frame(s)`);
  } else if (args.input) {
    const files = await listPngs(args.input);
    let imported = 0;
    for (const file of files) {
      await service.importBuffer(path.basename(file.key), file.key, file.bytes);
      imported++;
    }
    console.log(`imported ${imported} PNG file(s) from ${args.input}`);
  }

  const build = await service.pack(settings);
  console.log(`packed ${build.manifest.summary.packed}/${build.manifest.summary.total} frame(s) into ${build.manifest.pages.length} page(s)`);
  for (const page of build.manifest.pages) {
    console.log(`  page ${page.index}: ${page.file} ${page.width}x${page.height} px`);
  }
  if (build.issues.length > 0) {
    console.log(`issues (${build.issues.length}):`);
    for (const issue of build.issues) console.log(`  [${issue.code}] ${issue.message}`);
  }

  // Animation: every packed, non-empty frame in id order, 100 ms each.
  const animationFrames = args.animation
    ? build.manifest.frames
        .filter((frame) => frame.status === 'packed' && !frame.empty)
        .slice(0, 8)
        .map((frame) => ({ id: frame.id, durationMs: 100 }))
    : [];
  const animation: AnimationSpec = {
    format: ANIMATION_FORMAT,
    name: 'cli-animation',
    loop: true,
    anchor: { x: 0.5, y: 1 },
    frames: animationFrames,
  };

  const exported = await service.export(build.buildId, animation);
  await fs.rm(args.out, { recursive: true, force: true });
  const record = service.getExport(exported.exportId);
  if (!record) throw new Error('export disappeared');
  const bundleFiles: Record<string, Uint8Array> = {};
  for (const file of Object.keys(record.artifacts.files)) {
    const data = record.artifacts.files[file];
    const target = path.join(args.out, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(data));
    bundleFiles[file] = data;
  }
  await fs.writeFile(path.join(args.out, 'sprite-atlas.zip'), record.artifacts.zip);
  console.log(`wrote ${Object.keys(bundleFiles).length} file(s) + sprite-atlas.zip to ${args.out}`);

  console.log('\nbuild verification:');
  for (const check of exported.verification.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id.padEnd(18)} ${check.detail}`);
  }
  console.log(`  ignored transparent RGB pixels: ${exported.verification.ignoredTransparentPixels}`);

  console.log('\nbundle-only verification (reloaded from disk, no source images):');
  const bundle = await verifyBundle(bundleFiles);
  for (const check of bundle.report.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id.padEnd(22)} ${check.detail}`);
  }
  for (const warning of bundle.report.warnings.slice(0, 10)) {
    console.log(`  WARN ${warning}`);
  }

  // Extra proof: rebuild each animation frame from the reloaded bundle and
  // compare against the original canvases held by the server.
  let compared = 0;
  let mismatched = 0;
  for (const frame of build.manifest.frames) {
    if (frame.status !== 'packed') continue;
    const stored = service.store.get(frame.id);
    if (!stored) continue;
    const page = frame.page === null ? null : bundle.loaded.pages.get(frame.page) ?? null;
    const reconstructed = reconstructFrame(frame, page);
    const comparison = compareImages(stored.image, reconstructed.canvas);
    compared++;
    if (!comparison.match) {
      mismatched++;
      console.log(`  FAIL frame ${frame.id} pixel mismatch`);
    }
  }
  console.log(`\nrelinked ${compared} frame(s) from exported PNGs, ${mismatched} mismatch(es)`);

  const ok = exported.verification.ok && bundle.report.ok && mismatched === 0;
  console.log(ok ? '\nRESULT: OK' : '\nRESULT: FAILED');
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
