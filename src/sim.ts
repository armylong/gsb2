import { Vec, segPoint, polylineAt, angleDiff, lerp, dist } from './geom.js';
import { LevelDef, ParadeDef, Layout, ViewerDef, Chair, RoundDef } from './model.js';

/**
 * 统一擦边规则:视线到遮挡物中心的水平距离 < 半径 - EDGE_EPS 才算挡住;
 * 擦到边缘(距离落在 [r-EPS, r] 内)一律视为看得见。
 * 预览、演出回放与结算都走同一个 checkSight,规则天然一致。
 */
export const EDGE_EPS = 2;
/** 观众身体占位半径(px)与头顶余量(米)。 */
export const BODY_R = 14;
export const HEAD_EXTRA = 0.25;

export interface BlockerHit { type: 'pillar' | 'sign' | 'viewer'; id: string; label: string }

export interface SightResult {
  visible: boolean;
  inFov: boolean;
  boatActive: boolean;
  blockers: BlockerHit[];
  boatPos: Vec | null;
}

export interface SightEvent {
  g: number;          // 全局时间(秒)
  round: number;
  viewerId: string;
  boatId: string;
  kind: 'lost' | 'gained';
  reason: string;     // 被谁挡住 / 转出朝向 / 船离场
}

export interface ViewerResult {
  viewerId: string;
  ok: boolean;
  detail: string;
  firstFailG: number | null; // 失去视野/错过时刻的全局时间,用于从记录跳回
}

export interface SimResult {
  roundStarts: number[];
  totalDuration: number;
  events: SightEvent[];
  viewers: ViewerResult[];
}

export function chairOfViewer(layout: Layout, viewerId: string): Chair | null {
  return layout.chairs.find(c => c.viewerId === viewerId) ?? null;
}

export function boatPosAt(round: RoundDef, boatId: string, speed: number, t: number): Vec | null {
  const route = round.routes[boatId];
  if (!route) return null;
  return polylineAt(route, speed * t);
}

/** 导览牌在轮次内某时刻的锚点(场中变化按演出时间生效)。 */
export function signAnchorAt(round: RoundDef, t: number): number {
  return round.signMove && t >= round.signMove.t ? round.signMove.anchor : round.signAnchor;
}

/** 核心视线判定:某轮某时刻,某观众(坐在某把椅子上)能否看见某船。 */
export function checkSight(
  level: LevelDef,
  layout: Layout,
  round: RoundDef,
  parade: ParadeDef,
  viewer: ViewerDef,
  chair: Chair,
  boatId: string,
  t: number,
): SightResult {
  const boat = parade.boats.find(b => b.id === boatId)!;
  const boatPos = boatPosAt(round, boatId, boat.speed, t);
  if (!boatPos) return { visible: false, inFov: false, boatActive: false, blockers: [], boatPos: null };

  const hole = level.holes.find(h => h.id === chair.holeId)!;
  const eye = hole.pos;
  const ang = Math.atan2(boatPos.y - eye.y, boatPos.x - eye.x);
  const inFov = Math.abs(angleDiff(ang, chair.facing)) <= viewer.fovHalf;

  const blockers: BlockerHit[] = [];
  const consider = (id: string, label: string, type: BlockerHit['type'], p: Vec, r: number, h: number) => {
    const sp = segPoint(eye, boatPos, p);
    if (sp.d >= r - EDGE_EPS) return;              // 擦边不算挡(统一规则)
    const lineH = lerp(viewer.eyeHeight, boat.height, sp.s);
    if (h > lineH) blockers.push({ type, id, label });
  };

  for (const pl of level.pillars) consider(pl.id, '立柱', 'pillar', pl.pos, pl.r, pl.height);
  const signPos = level.sign.anchors[signAnchorAt(round, t)];
  consider('sign', '导览牌', 'sign', signPos, level.sign.r, level.sign.height);
  for (const other of layout.chairs) {
    if (!other.viewerId || other.viewerId === viewer.id) continue;
    const ov = level.viewers.find(x => x.id === other.viewerId)!;
    const oh = level.holes.find(h => h.id === other.holeId)!;
    consider(other.viewerId, `观众·${ov.name}`, 'viewer', oh.pos, BODY_R, ov.eyeHeight + HEAD_EXTRA);
  }

  return { visible: inFov && blockers.length === 0, inFov, boatActive: true, blockers, boatPos };
}

const DT = 0.1;

/** 整场演出仿真:逐轮逐步推进,记录视线得失事件并按每人的约定结算。 */
export function simulate(level: LevelDef, parade: ParadeDef, layout: Layout): SimResult {
  const roundStarts: number[] = [];
  let g = 0;
  for (const r of parade.rounds) { roundStarts.push(g); g += r.duration; }

  const events: SightEvent[] = [];
  const viewers: ViewerResult[] = [];

  for (const viewer of level.viewers) {
    const chair = chairOfViewer(layout, viewer.id);
    if (!chair) {
      viewers.push({ viewerId: viewer.id, ok: false, detail: '没有座位', firstFailG: 0 });
      continue;
    }
    const boatId = viewer.contract.boatId;
    const boat = parade.boats.find(b => b.id === boatId)!;

    if (viewer.contract.kind === 'full') {
      const minRatio = viewer.contract.minRatio;
      let failRound = -1;
      let firstLostG: number | null = null;
      const roundDetails: string[] = [];
      for (let ri = 0; ri < parade.rounds.length; ri++) {
        const round = parade.rounds[ri];
        let active = 0, vis = 0;
        let prev: boolean | null = null;
        for (let t = 0; t <= round.duration + 1e-9; t += DT) {
          const s = checkSight(level, layout, round, parade, viewer, chair, boatId, t);
          if (!s.boatActive) { if (prev === true) { events.push({ g: roundStarts[ri] + t, round: ri, viewerId: viewer.id, boatId, kind: 'lost', reason: '船已离场' }); } prev = null; continue; }
          active += DT;
          if (s.visible) vis += DT;
          if (prev !== null && s.visible !== prev) {
            events.push({
              g: roundStarts[ri] + t, round: ri, viewerId: viewer.id, boatId,
              kind: s.visible ? 'gained' : 'lost',
              reason: s.visible ? '重新看见' : (!s.inFov ? '转出可接受朝向' : s.blockers.map(b => b.label).join('、')),
            });
            if (!s.visible && failRound === -1 && firstLostG === null) firstLostG = roundStarts[ri] + t;
          }
          prev = s.visible;
        }
        const ratio = active > 0 ? vis / active : 0;
        roundDetails.push(`${round.name} ${(ratio * 100).toFixed(0)}%`);
        if (ratio + 1e-9 < minRatio && failRound === -1) failRound = ri;
      }
      const ok = failRound === -1;
      viewers.push({
        viewerId: viewer.id, ok,
        detail: `需每轮≥${(minRatio * 100).toFixed(0)}%看见「${boat.name}」:` + roundDetails.join(' / ') + (ok ? '' : ` — ${parade.rounds[failRound].name} 不达标`),
        firstFailG: ok ? null : (firstLostG ?? roundStarts[failRound]),
      });
    } else {
      const missed: { label: string; g: number }[] = [];
      for (const mid of viewer.contract.moments) {
        let found: { ri: number; t: number; label: string } | null = null;
        for (let ri = 0; ri < parade.rounds.length; ri++) {
          const m = parade.rounds[ri].keyMoments.find(k => k.id === mid);
          if (m) { found = { ri, t: m.t, label: m.label }; break; }
        }
        if (!found) continue;
        const round = parade.rounds[found.ri];
        const s = checkSight(level, layout, round, parade, viewer, chair, boatId, found.t);
        if (!s.visible) missed.push({ label: found.label, g: roundStarts[found.ri] + found.t });
      }
      const ok = missed.length === 0;
      viewers.push({
        viewerId: viewer.id, ok,
        detail: ok
          ? `关键时刻全部看见「${boat.name}」`
          : `错过关键时刻:${missed.map(m => m.label).join('、')}`,
        firstFailG: ok ? null : missed[0].g,
      });
    }
  }

  events.sort((a, b) => a.g - b.g);
  return { roundStarts, totalDuration: g, events, viewers };
}

/** 布局校验:两把椅子占同一孔位 → 非法,保持原布置。 */
export function layoutConflict(layout: Layout): string | null {
  const seen = new Map<string, string>();
  for (const c of layout.chairs) {
    const prev = seen.get(c.holeId);
    if (prev) return `椅子 ${prev} 与 ${c.id} 占了同一孔位 ${c.holeId}`;
    seen.set(c.holeId, c.id);
  }
  return null;
}

export function cloneLayout(l: Layout): Layout {
  return { chairs: l.chairs.map(c => ({ ...c })) };
}

export { dist };
