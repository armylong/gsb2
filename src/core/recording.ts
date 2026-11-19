import { ActionId, SceneId, SCENES, isActionId } from './bindings';
import { SimState, Simulation, initialSimState } from './sim';

/** 录像时长上限：30 秒 × 60 tick/s */
export const MAX_TICKS = 30 * 60;
export const CHECKPOINT_INTERVAL = 30;

export type RecEvent =
  | { tick: number; type: 'down'; action: ActionId }
  | { tick: number; type: 'up'; action: ActionId }
  | { tick: number; type: 'edge'; action: ActionId }
  | { tick: number; type: 'scene'; scene: SceneId };

export interface Checkpoint {
  tick: number;
  x: number;
  y: number;
  interactCount: number;
  confirmCount: number;
  paused: boolean;
  scene: SceneId;
  menuIndex: number;
}

export interface Recording {
  version: 1;
  name: string;
  durationTicks: number;
  initial: { x: number; y: number; scene: SceneId };
  events: RecEvent[];
  checkpoints: Checkpoint[];
  final: Checkpoint;
}

export function snapshotOf(s: SimState): Checkpoint {
  return {
    tick: s.tick,
    x: s.x,
    y: s.y,
    interactCount: s.interactCount,
    confirmCount: s.confirmCount,
    paused: s.paused,
    scene: s.scene,
    menuIndex: s.menuIndex,
  };
}

export function checkpointsEqual(a: Checkpoint, b: Checkpoint): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.interactCount === b.interactCount &&
    a.confirmCount === b.confirmCount &&
    a.paused === b.paused &&
    a.scene === b.scene &&
    a.menuIndex === b.menuIndex
  );
}

/** 对录像内容做稳定哈希，任何修改都会使旧的校验结果失效 */
export function recordingHash(rec: Recording): string {
  const s = JSON.stringify([rec.durationTicks, rec.initial, rec.events, rec.checkpoints, rec.final]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export type ValidationResult = { ok: true; rec: Recording } | { ok: false; error: string };

/** 严格校验录像文件；不通过时绝不进入回放 */
export function validateRecording(data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null) return { ok: false, error: '不是有效的录像对象' };
  const r = data as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: `不支持的录像版本: ${String(r.version)}` };
  if (typeof r.name !== 'string') return { ok: false, error: '缺少录像名称' };
  if (!Number.isInteger(r.durationTicks) || (r.durationTicks as number) <= 0)
    return { ok: false, error: '录像时长非法' };
  if ((r.durationTicks as number) > MAX_TICKS)
    return { ok: false, error: `录像超过 30 秒上限（${r.durationTicks} tick）` };
  const init = r.initial as Record<string, unknown>;
  if (!init || typeof init.x !== 'number' || typeof init.y !== 'number' || !SCENES.includes(init.scene as SceneId))
    return { ok: false, error: '初始状态非法' };
  if (!Array.isArray(r.events)) return { ok: false, error: '事件列表缺失' };
  let prevTick = -1;
  for (let i = 0; i < r.events.length; i++) {
    const e = r.events[i] as Record<string, unknown>;
    if (!Number.isInteger(e.tick) || (e.tick as number) < 0 || (e.tick as number) > (r.durationTicks as number))
      return { ok: false, error: `事件 #${i} 的时刻非法` };
    if ((e.tick as number) < prevTick)
      return { ok: false, error: `事件 #${i} 的时刻出现倒退（${e.tick} < ${prevTick}）` };
    prevTick = e.tick as number;
    if (e.type === 'scene') {
      if (!SCENES.includes(e.scene as SceneId)) return { ok: false, error: `事件 #${i} 含有不存在的场景` };
    } else if (e.type === 'down' || e.type === 'up' || e.type === 'edge') {
      if (!isActionId(e.action)) return { ok: false, error: `事件 #${i} 含有不存在的动作: ${String(e.action)}` };
    } else {
      return { ok: false, error: `事件 #${i} 类型未知: ${String(e.type)}` };
    }
  }
  if (!Array.isArray(r.checkpoints) || typeof r.final !== 'object' || r.final === null)
    return { ok: false, error: '核对点数据缺失' };
  return { ok: true, rec: data as Recording };
}

/** 用事件序列跑一遍确定性模拟，返回核对点与最终状态（录制收尾与回放共用） */
export function simulateEvents(
  initial: { x: number; y: number; scene: SceneId },
  events: RecEvent[],
  durationTicks: number,
): { sim: Simulation; checkpoints: Checkpoint[]; final: Checkpoint } {
  const sim = new Simulation({ x: initial.x, y: initial.y, scene: initial.scene });
  const checkpoints: Checkpoint[] = [];
  let ptr = 0;
  while (sim.state.tick < durationTicks) {
    while (ptr < events.length && events[ptr].tick <= sim.state.tick) {
      applyEvent(sim, events[ptr]);
      ptr++;
    }
    sim.step();
    if (sim.state.tick % CHECKPOINT_INTERVAL === 0) checkpoints.push(snapshotOf(sim.state));
  }
  return { sim, checkpoints, final: snapshotOf(sim.state) };
}

function applyEvent(sim: Simulation, e: RecEvent) {
  if (e.type === 'down') sim.actionDown(e.action);
  else if (e.type === 'up') sim.actionUp(e.action);
  else if (e.type === 'edge') sim.fireEdge(e.action);
  else sim.state.scene = e.scene;
}

export interface Divergence {
  tick: number;
  expected: Checkpoint;
  actual: Checkpoint;
}

export interface ReplayResult {
  final: Checkpoint;
  expectedFinal: Checkpoint;
  firstDivergence: Divergence | null;
  checkpointsChecked: number;
  checkpointsPassed: number;
  match: boolean;
}

/** 回放录像并与核对点比较，定位首个不一致的位置 */
export function runReplay(rec: Recording): ReplayResult {
  const { sim, checkpoints } = simulateEvents(rec.initial, rec.events, rec.durationTicks);
  let firstDivergence: Divergence | null = null;
  let passed = 0;
  const n = Math.min(checkpoints.length, rec.checkpoints.length);
  for (let i = 0; i < n; i++) {
    if (checkpointsEqual(checkpoints[i], rec.checkpoints[i])) {
      passed++;
    } else if (!firstDivergence) {
      firstDivergence = { tick: rec.checkpoints[i].tick, expected: rec.checkpoints[i], actual: checkpoints[i] };
    }
  }
  const final = snapshotOf(sim.state);
  const match = firstDivergence === null && checkpointsEqual(final, rec.final);
  return {
    final,
    expectedFinal: rec.final,
    firstDivergence,
    checkpointsChecked: n,
    checkpointsPassed: passed,
    match,
  };
}
