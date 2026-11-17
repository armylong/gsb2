// Generates a sample export JSON (closed loop, constant speed) for the docs.
import { writeFile, mkdir } from 'node:fs/promises';
import { CameraRig } from '../src/core/CameraRig.ts';
import { closedPreset } from '../src/core/presets.ts';
import { buildExport } from '../src/core/exporter.ts';

const preset = closedPreset();
const rig = new CameraRig(preset.path, preset.playback);
const doc = buildExport(rig, { intervalSeconds: 2 });
await mkdir('docs', { recursive: true });
await writeFile('docs/sample-export.closed-loop.json', JSON.stringify(doc, null, 2));
console.log(`wrote docs/sample-export.closed-loop.json with ${doc.frames.length} frames`);
