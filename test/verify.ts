/**
 * 样例验证器: 在 Node 中以固定步长回放全部录入样例, 断言动作状态流转。
 * 运行: npm run verify
 */
import { createWorld } from '../src/sim/level.js';
import {
  createCharacter, step, overlaps, WALL_SLIDE_SPEED,
} from '../src/sim/physics.js';
import { SAMPLES, type SampleDef } from '../src/sim/samples.js';
import type { CharState } from '../src/sim/types.js';

const DT = 1 / 60;

interface RunResult {
  transitions: CharState[];
  stateAt(t: number): CharState | undefined;
  maxVyWallslide: number;
  overlapped: boolean;
}

function replay(def: SampleDef): RunResult {
  const world = createWorld();
  const c = createCharacter(def.spawn);
  const transitions: CharState[] = [];
  const timeline: { t: number; state: CharState }[] = [];
  let maxVyWallslide = 0;
  let overlapped = false;
  let last: CharState | null = null;

  const frames = Math.round(def.duration / DT);
  for (let i = 0; i <= frames; i++) {
    const t = i * DT;
    step(world, c, def.inputAt(t), DT);
    if (c.state !== last) {
      transitions.push(c.state);
      last = c.state;
    }
    timeline.push({ t, state: c.state });
    if (c.state === 'wallslide') maxVyWallslide = Math.max(maxVyWallslide, c.vy);
    // 全局不变量: 任何时刻角色不得与碰撞体重叠(翻身不得穿模)
    if (world.platforms.some((p) => overlaps(c, p))) overlapped = true;
  }
  return {
    transitions,
    stateAt: (t) => timeline.find((e) => e.t >= t)?.state,
    maxVyWallslide,
    overlapped,
  };
}

function isSubsequence<T>(needle: T[], haystack: T[]): boolean {
  let i = 0;
  for (const v of haystack) if (v === needle[i]) i++;
  return i === needle.length;
}

let failed = 0;
for (const def of SAMPLES) {
  const r = replay(def);
  const problems: string[] = [];
  const exp = def.expect;

  if (!isSubsequence(exp.sequence, r.transitions)) {
    problems.push(`状态流转 ${JSON.stringify(r.transitions)} 未按序包含 ${JSON.stringify(exp.sequence)}`);
  }
  for (const s of exp.never ?? []) {
    if (r.transitions.includes(s)) problems.push(`出现了禁止状态 ${s}`);
  }
  if (exp.endState) {
    const end = r.transitions[r.transitions.length - 1];
    if (end !== exp.endState) problems.push(`结束状态为 ${end}, 期望 ${exp.endState}`);
  }
  if (exp.atTime) {
    const s = r.stateAt(exp.atTime.t);
    if (s !== exp.atTime.state) problems.push(`t=${exp.atTime.t}s 时状态为 ${s}, 期望 ${exp.atTime.state}`);
  }
  if (exp.checkWallSlideCap && r.maxVyWallslide > WALL_SLIDE_SPEED + 1e-6) {
    problems.push(`贴墙滑落 vy 峰值 ${r.maxVyWallslide.toFixed(1)} 超过上限 ${WALL_SLIDE_SPEED}`);
  }
  if (r.overlapped) problems.push('回放中角色与碰撞体发生重叠(穿模)');

  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${def.name} - ${def.desc}`);
  console.log(`       状态流转: ${r.transitions.join(' -> ')}`);
  if (exp.checkWallSlideCap) console.log(`       贴墙滑落 vy 峰值: ${r.maxVyWallslide.toFixed(1)} (上限 ${WALL_SLIDE_SPEED})`);
  for (const p of problems) console.log(`       !! ${p}`);
}

console.log(failed === 0 ? `\n全部 ${SAMPLES.length} 个样例验证通过` : `\n${failed} 个样例验证失败`);
process.exit(failed === 0 ? 0 : 1);
