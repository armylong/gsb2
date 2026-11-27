import type { Action, Gear } from '../game/types';
import { legalTargets } from '../game/engine';
import type { Session } from '../game/session';
import type { HitTarget } from './render';
import { getSimCloseRect } from './render';

export interface UiState {
  screen: 'intro' | 'play';
  message: string | null;
}

function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function pendingText(session: Session): string {
  const a = session.pendingAction;
  if (a.type === 'pass') return '本拍计划：空拍（不移动）';
  const d = session.state.doughs.find((x) => x.id === a.doughId);
  const zoneName = { proof: '温箱', rack: '凉架', oven: '烤炉', bench: '案板' } as const;
  return `本拍计划：${d?.name ?? a.doughId} 移到${zoneName[a.target]}`;
}

export function handleClick(
  session: Session,
  ui: UiState,
  hits: HitTarget[],
  mx: number,
  my: number,
  onStartLevel: (levelId: string) => void,
  onBackToIntro: () => void,
): void {
  ui.message = null;

  // 模拟浮层打开时，只响应关闭按钮
  if (session.simulation) {
    if (inRect(mx, my, getSimCloseRect())) session.simulation = null;
    return;
  }

  const hit = hits.find((h) => inRect(mx, my, h));
  if (!hit) return;

  if (ui.screen === 'intro') {
    if (hit.kind === 'level-card' && hit.payload) onStartLevel(hit.payload);
    return;
  }

  switch (hit.kind) {
    case 'level-card':
      if (hit.payload) onStartLevel(hit.payload);
      return;
    case 'gear':
      session.changeGear(Number(hit.payload) as Gear);
      return;
    case 'button':
      handleButton(session, ui, hit.id, onBackToIntro);
      return;
    case 'dough':
      if (hit.payload) session.selectDough(hit.payload);
      return;
    case 'zone':
      planZoneMove(session, ui, hit.payload as 'proof' | 'rack' | 'oven');
      return;
    default:
      return;
  }
}

function planZoneMove(session: Session, ui: UiState, target: 'proof' | 'rack' | 'oven'): void {
  const id = session.selectedDoughId;
  if (!id) {
    ui.message = '先点选一团面，再点目标工位';
    return;
  }
  if (!legalTargets(session.state, id).includes(target)) {
    const d = session.state.doughs.find((x) => x.id === id);
    ui.message = `${d?.name ?? id} 现在不能去该工位（槽位/炉位被占，或它正在烘烤）`;
    return;
  }
  session.planMove(id, target);
}

function handleButton(session: Session, ui: UiState, id: string, onBackToIntro: () => void): void {
  switch (id) {
    case 'btn-pass':
      session.planPass();
      return;
    case 'btn-sim': {
      const r = session.preview();
      if (r.rejected) ui.message = r.rejected;
      return;
    }
    case 'btn-commit': {
      const r = session.commit();
      if (r.rejected) ui.message = r.rejected;
      return;
    }
    case 'btn-undo':
      if (!session.undo()) ui.message = '没有可撤销的回合';
      return;
    case 'btn-reset':
      session.reset();
      ui.message = null;
      return;
    case 'btn-back':
      onBackToIntro();
      return;
    default:
      return;
  }
}

export function handleKey(session: Session, ui: UiState, key: string): void {
  if (session.simulation) {
    if (key === 'Escape' || key === 's' || key === ' ') session.simulation = null;
    return;
  }
  if (ui.screen !== 'play') return;
  switch (key) {
    case 's':
    case 'S':
      session.preview();
      return;
    case ' ':
    case 'Enter': {
      const r = session.commit();
      if (r.rejected) ui.message = r.rejected;
      return;
    }
    case 'u':
    case 'U':
      if (!session.undo()) ui.message = '没有可撤销的回合';
      return;
    case 'r':
    case 'R':
      session.reset();
      ui.message = null;
      return;
    case '0':
    case '1':
    case '2':
      session.changeGear(Number(key) as Gear);
      return;
    default:
      return;
  }
}

export function describeAction(a: Action): string {
  return a.type === 'pass' ? '空拍' : `移动 ${a.doughId} → ${a.target}`;
}
