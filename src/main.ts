import { createWorld } from './sim/level.js';
import { createCharacter, step } from './sim/physics.js';
import { SAMPLES, type SampleDef } from './sim/samples.js';
import { Keyboard } from './input.js';
import { render } from './render.js';

const DT = 1 / 60;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const world = createWorld();
const character = createCharacter(world.spawn);
const keyboard = new Keyboard();

let replay: { def: SampleDef; t: number } | null = null;

function resetToSpawn(): void {
  Object.assign(character, createCharacter(world.spawn));
  replay = null;
}

function startReplay(index: number): void {
  const def = SAMPLES[index];
  if (!def) return;
  Object.assign(character, createCharacter(def.spawn));
  replay = { def, t: 0 };
}

let acc = 0;
let lastTs = performance.now();

function frame(ts: number): void {
  acc += Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;

  while (acc >= DT) {
    const pressed = keyboard.drainPressed();
    if (pressed.has('KeyR')) resetToSpawn();
    for (let i = 0; i < SAMPLES.length; i++) {
      if (pressed.has(`Digit${i + 1}`)) startReplay(i);
    }

    let input;
    if (replay) {
      input = replay.def.inputAt(replay.t);
      replay.t += DT;
      if (replay.t >= replay.def.duration) replay = null; // 回放结束, 交还控制
    } else {
      input = keyboard.poll();
    }
    step(world, character, input, DT);
    acc -= DT;
  }

  render(ctx, world, character, { replay });
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
