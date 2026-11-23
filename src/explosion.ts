/**
 * 爆炸进度核心数学
 *
 * 关键设计:
 * - 总进度 [0,1] 被两段平分: 第一段占 0~0.5, 第二段占 0.5~1
 * - 每个零件的 step 用「段内 start/end」描述动作窗口, 拖动总进度即可看出当前是哪一段、哪组在动
 * - 零件 Object3D 按 parentId 嵌套, 每帧只写 localPosition = 装配位置 + 自身局部爆炸偏移;
 *   父组件移动后子零件被场景图自动带走, 子零件再沿自己的局部 dir 叠加位移,
 *   因此盖板被提起后, 螺钉仍然沿自己的装配方向(盖板局部轴)抽出 —— 已展开的位移不会被重算
 */
import type { ExplodeStep, PartDef, Vec3Tuple } from './types';

export const PHASE_COUNT = 2;
/** 每段在总进度轴上的宽度 */
export const PHASE_SPAN = 1 / PHASE_COUNT;
/** 平滑缓动, 让拖动手感不生硬 */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 当前总进度落在哪一段; 恰好在分界点归到后一段 */
export function activePhase(global: number): 0 | 1 {
  return global < PHASE_SPAN ? 0 : 1;
}

/** 总进度换算为段内进度 [0,1] */
export function localInPhase(global: number): number {
  const phase = activePhase(global);
  return clamp01((global - phase * PHASE_SPAN) / PHASE_SPAN);
}

/** 全局进度 -> 该 step 自身的完成度 [0,1], 不在自己段内时取 0 或 1(保持, 不回弹) */
export function stepProgress(step: ExplodeStep, global: number): number {
  if (step.phase !== activePhase(global)) {
    // 上一段已完成的零件保持在终点; 还没轮到的零件保持在起点
    return step.phase < activePhase(global) ? 1 : 0;
  }
  const local = localInPhase(global);
  if (local <= step.start) return 0;
  if (local >= step.end) return 1;
  return smoothstep((local - step.start) / (step.end - step.start));
}

/** 计算一个零件在「直接父节点局部空间」内的爆炸偏移量 */
export function localExplodeOffset(step: ExplodeStep | null, global: number): Vec3Tuple {
  if (!step) return [0, 0, 0];
  const p = stepProgress(step, global);
  const [x, y, z] = step.dir;
  const len = Math.hypot(x, y, z) || 1;
  const d = step.distance * p;
  return [(x / len) * d, (y / len) * d, (z / len) * d];
}

export interface ActiveInfo {
  phase: 0 | 1;
  /** 当前窗口内正在动作的零件 */
  movingParts: PartDef[];
}

/** 给定总进度, 找出正在动作的段与零件(用于界面高亮「目前是哪组在动作」) */
export function evaluateActive(config: { parts: PartDef[] }, global: number): ActiveInfo {
  const phase = activePhase(global);
  const local = localInPhase(global);
  const movingParts = config.parts.filter(
    (p) =>
      p.step &&
      p.step.phase === phase &&
      local > p.step.start &&
      local < p.step.end,
  );
  return { phase, movingParts };
}

/** 段内窗口 -> 全局进度区间, 供时间轴渲染与干涉区间换算 */
export function phaseWindowToGlobal(phase: 0 | 1, start: number, end: number): [number, number] {
  return [phase * PHASE_SPAN + start * PHASE_SPAN, phase * PHASE_SPAN + end * PHASE_SPAN];
}
