/**
 * 程序内置样例路线（全部由跑道参数生成，不依赖外部数据）：
 *  - valid     正常一圈：G0→G1→G2→G3 顺序正向，可生成幻影
 *  - edge      贴边一圈：沿内边界行驶，同样应得到有效圈，圈速与 valid 不同
 *  - reverse   逆行：正向过 G0 起步后反向穿回 G0
 *  - cut       横穿（跳关）：切内场直插，跳过 G2 先碰到 G3
 *  - overlap   共线重叠：沿 G0 闸门线段滑行，不构成穿越
 *  - highspeed 高速跨双闸：一帧位移同时扫过 G1、G2，验证同帧双触发与 sub-frame 时刻
 */
import { Track } from './track';
import { Path, Keyframe, withAutoAngles } from './path';
import { Vec2, v, add, scale } from './geometry';

export interface SampleDef {
  id: string;
  label: string;
  description: string;
  path: Path;
}

const wrap = (f: number): number => ((f % 1) + 1) % 1;

/** 沿跑道中心线 fraction 移动，offset 为朝内法线方向的横向偏移（正=贴内边） */
function lanePosition(track: Track, fraction: number, offset: number): Vec2 {
  return add(track.positionAt(fraction), scale(track.normalAt(fraction), offset));
}

function buildLanePath(
  track: Track,
  f0: number,
  f1: number,
  duration: number,
  offset: number,
  pieces: number,
): Path {
  const raw: Omit<Keyframe, 'angle'>[] = [];
  for (let i = 0; i <= pieces; i++) {
    const u = i / pieces;
    const f = f0 + (f1 - f0) * u;
    raw.push({ t: duration * u, pos: lanePosition(track, f, offset) });
  }
  return new Path(withAutoAngles(raw));
}

export function buildSamples(track: Track): SampleDef[] {
  const gateF = track.gates.map((g) => g.fraction);
  const halfW = track.width / 2;
  const margin = 8;

  // 1) 正常一圈：G0 稍前出发，顺时针走完整一圈，G3 之后即停（不再穿 G0）
  const valid: SampleDef = {
    id: 'valid',
    label: '正常一圈（可录幻影）',
    description: '沿中心线顺时针，依次正向通过 G0→G1→G2→G3，应得到 1 个有效圈。',
    path: buildLanePath(track, gateF[0] - 0.02, gateF[3] + 0.015, 9.6, 0, 240),
  };

  // 2) 贴边一圈：贴着内边界（留 8px 余量），圈更短，仍是有效圈
  const edge: SampleDef = {
    id: 'edge',
    label: '贴边一圈',
    description: `沿内边界 ${margin}px 余量行驶，闸门线段横跨整个跑道宽度，贴边仍能顺序触发，应得到有效圈。`,
    path: buildLanePath(track, gateF[0] - 0.02, gateF[3] + 0.015, 9.0, halfW - margin, 240),
  };

  // 3) 逆行：过 G0 起步后继续前进一点，再原路返回反向穿过 G0
  const reverseTurnF = gateF[0] + 0.06;
  const reverseRaw: Omit<Keyframe, 'angle'>[] = [
    { t: 0, pos: lanePosition(track, gateF[0] - 0.02, 0) },
    { t: 2.4, pos: lanePosition(track, reverseTurnF, 0) },
    { t: 5.2, pos: lanePosition(track, gateF[0] - 0.02, 0) },
  ];
  const reverse: SampleDef = {
    id: 'reverse',
    label: '逆行（反向穿闸）',
    description: '正向通过 G0 起步后折返，反向穿过 G0，应判定逆行并作废当前圈。',
    path: new Path(withAutoAngles(reverseRaw)),
  };

  // 4) 横穿（跳关）：过 G1 后从底直道斜切内场直登顶直道，整条斜线不经过左直道，
  //    从而跳过 G2（左直道闸门），先碰到 G3（顶直道闸门）→ 跳关
  const cutRaw: Omit<Keyframe, 'angle'>[] = [
    { t: 0, pos: lanePosition(track, gateF[0] - 0.02, 0) },
    { t: 1.6, pos: lanePosition(track, gateF[0] + 0.03, 0) }, // 正向过 G0 起步
    { t: 2.6, pos: lanePosition(track, gateF[1] - 0.03, 0) }, // 底直道 G1 之前
    { t: 3.4, pos: lanePosition(track, gateF[1] + 0.02, 0) }, // 顺序通过 G1
    // 斜切内场：从底直道中点附近直登顶直道（x 保持在中段，远离左直道 x=120）
    { t: 5.0, pos: lanePosition(track, gateF[3] - 0.05, 0) },
    { t: 6.2, pos: lanePosition(track, gateF[3] + 0.02, 0) }, // 先撞 G3（期望是 G2）
  ];
  const cut: SampleDef = {
    id: 'cut',
    label: '横穿 / 跳关',
    description: '过 G1 后斜切内场直登顶直道，整条路线不经过左直道、跳过 G2，先碰到 G3 应判定跳关。',
    path: new Path(withAutoAngles(cutRaw)),
  };

  // 5) 共线重叠：先跨进 G0 一侧、沿闸门线段滑行、再退回，全程不跨线
  const g0 = track.gates[0];
  const slide = (u: number): Vec2 => ({
    x: g0.a.x + (g0.b.x - g0.a.x) * u,
    y: g0.a.y + (g0.b.y - g0.a.y) * u,
  });
  const overlapRaw: Omit<Keyframe, 'angle'>[] = [
    { t: 0, pos: v(g0.center.x + 120, g0.center.y) }, // G0 右侧（未起步区）
    { t: 1.0, pos: slide(0.15) }, // 抵达闸门端点内侧（不跨线）
    { t: 3.0, pos: slide(0.85) }, // 沿闸门滑行：共线重叠
    { t: 4.2, pos: v(g0.center.x + 120, g0.center.y) }, // 退回原侧
  ];
  const overlap: SampleDef = {
    id: 'overlap',
    label: '贴闸门滑行（共线重叠）',
    description: '运动方向与 G0 闸门平行并在线段上滑行，没有从一侧跨到另一侧，不产生计时触发。',
    path: new Path(withAutoAngles(overlapRaw)),
  };

  // 6) 高速跨双闸：关键帧刻意拉开，使大步长（低帧率）下一帧扫过 G1 与 G2。
  //    跳跃终点取 G2 刚过的位置（fraction 只多 0.005），保证长线段依次穿过两扇闸门。
  const highRaw: Omit<Keyframe, 'angle'>[] = [
    { t: 0, pos: lanePosition(track, gateF[0] - 0.02, 0) },
    { t: 0.5, pos: lanePosition(track, gateF[0] + 0.02, 0) }, // 起步过 G0
    { t: 1.0, pos: lanePosition(track, gateF[1] - 0.02, 0) }, // G1 之前
    // 下一帧直接出现在 G2 之前：同帧扫过 G1（底）、G2（左），且对 G2 是正向穿越
    { t: 1.5, pos: lanePosition(track, wrap(gateF[2] - 0.005), 0) },
    { t: 2.4, pos: lanePosition(track, gateF[3] - 0.02, 0) },
    { t: 2.9, pos: lanePosition(track, gateF[3] + 0.015, 0) }, // 完赛
  ];
  const highspeed: SampleDef = {
    id: 'highspeed',
    label: '高速同帧跨双闸',
    description: '关键帧跨度极大：在 4fps 下一帧同时扫过 G1、G2，两扇闸都应给出各自的 sub-frame 触发时刻。',
    path: new Path(withAutoAngles(highRaw)),
  };

  return [valid, edge, reverse, cut, overlap, highspeed];
}
