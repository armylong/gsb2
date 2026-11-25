import { audio } from '../audio/engine';
import { conditionLabel } from '../game/evidence';
import { PLATE_MAP } from '../game/plates';
import { store } from '../state/store';
import type { ConditionKey, PlateId } from '../game/types';
import { toast } from './feedback';

/** 给被点击的发声元素加一个短暂的声波扩散动画。 */
export function flashDisc(anchor: HTMLElement | null): void {
  if (!anchor) return;
  const disc = anchor.matches('.plate-disc, .truth-disc')
    ? anchor
    : anchor.querySelector<HTMLElement>('.plate-disc, .truth-disc');
  if (!disc) return;
  disc.classList.remove('playing');
  // 强制重排以重启动画
  void disc.offsetWidth;
  disc.classList.add('playing');
  window.setTimeout(() => disc.classList.remove('playing'), 650);
}

export function playSolo(plateId: PlateId, damp: boolean, anchor?: HTMLElement): void {
  audio.playPlate(PLATE_MAP[plateId], { damp });
  flashDisc(anchor ?? null);
}

/** 敲响木盒：未用过的条件登记为一次新敲击；已保留条件直接回放。 */
export function strikeOrReplay(key: ConditionKey, anchor?: HTMLElement): void {
  const puzzle = store.currentPuzzle;
  const p = store.progress;
  const tested = p.records.some((r) => r.key === key);

  if (tested) {
    audio.playCondition(puzzle.truth, key);
    flashDisc(anchor ?? null);
    return;
  }

  const check = store.canStrike(key);
  if (!check.ok) {
    toast(check.reason ?? '现在不能敲击');
    return;
  }

  audio.playCondition(puzzle.truth, key);
  store.registerStrike(key);
  // registerStrike 触发整页重渲染；在新按钮上补一个瞬时反馈
  window.setTimeout(() => {
    const btn = document.querySelector<HTMLElement>(`[data-strike="${key}"]`);
    flashDisc(btn);
    btn?.classList.add('just-struck');
    window.setTimeout(() => btn?.classList.remove('just-struck'), 700);
  }, 0);
}

export function replayCondition(key: ConditionKey, anchor?: HTMLElement): void {
  audio.playCondition(store.currentPuzzle.truth, key);
  flashDisc(anchor ?? null);
  toast(`回放：${conditionLabel(key)}（不消耗次数）`, 1400);
}

/** 结束核对里的顺序鉴别演示。 */
export function runDemo(
  items: { plate: PlateId; damp?: boolean; hold?: number }[],
  anchor?: HTMLElement,
): void {
  audio.playSequence(items);
  flashDisc(anchor ?? null);
}
