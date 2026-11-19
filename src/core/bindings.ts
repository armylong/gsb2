import { Chord, chordEquals, chordSatisfied, specificity } from './keys';

export type SceneId = 'game' | 'menu';
export const SCENES: SceneId[] = ['game', 'menu'];
export const SCENE_LABEL: Record<SceneId, string> = { game: '游戏场景', menu: '菜单场景' };

export type ActionId =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'dash'
  | 'interact'
  | 'pause';

export type ActionKind = 'continuous' | 'edge';

export interface ActionDef {
  id: ActionId;
  label: string;
  kind: ActionKind;
  /** 在不同场景下的含义说明 */
  hint: Record<SceneId, string>;
}

export const ACTIONS: ActionDef[] = [
  { id: 'moveUp', label: '上移', kind: 'continuous', hint: { game: '角色向上移动', menu: '菜单光标上移' } },
  { id: 'moveDown', label: '下移', kind: 'continuous', hint: { game: '角色向下移动', menu: '菜单光标下移' } },
  { id: 'moveLeft', label: '左移', kind: 'continuous', hint: { game: '角色向左移动', menu: '（菜单中未使用）' } },
  { id: 'moveRight', label: '右移', kind: 'continuous', hint: { game: '角色向右移动', menu: '（菜单中未使用）' } },
  { id: 'dash', label: '冲刺', kind: 'edge', hint: { game: '向面朝方向冲刺', menu: '（菜单中未使用）' } },
  { id: 'interact', label: '交互', kind: 'edge', hint: { game: '与场景交互（计数）', menu: '确认菜单项（计数）' } },
  { id: 'pause', label: '暂停', kind: 'edge', hint: { game: '暂停/继续', menu: '返回游戏场景' } },
];

export const ACTION_MAP: Record<ActionId, ActionDef> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a]),
) as Record<ActionId, ActionDef>;

export function isActionId(s: unknown): s is ActionId {
  return typeof s === 'string' && ACTIONS.some((a) => a.id === s);
}

export type BindingMap = Record<SceneId, Record<ActionId, Chord | null>>;

export function defaultBindings(): BindingMap {
  return {
    game: {
      moveUp: { code: 'KeyW', modifiers: [] },
      moveDown: { code: 'KeyS', modifiers: [] },
      moveLeft: { code: 'KeyA', modifiers: [] },
      moveRight: { code: 'KeyD', modifiers: [] },
      dash: { code: 'Space', modifiers: [] },
      interact: { code: 'KeyE', modifiers: [] },
      pause: { code: 'Escape', modifiers: [] },
    },
    menu: {
      moveUp: { code: 'ArrowUp', modifiers: [] },
      moveDown: { code: 'ArrowDown', modifiers: [] },
      moveLeft: null,
      moveRight: null,
      dash: null,
      interact: { code: 'Enter', modifiers: [] },
      pause: { code: 'Escape', modifiers: [] },
    },
  };
}

export function cloneBindings(map: BindingMap): BindingMap {
  return JSON.parse(JSON.stringify(map)) as BindingMap;
}

/**
 * 查找同场景内的完全重复绑定。
 * 返回冲突的动作 id；无冲突返回 null。不同场景不复查（允许复用）。
 */
export function findConflict(
  map: BindingMap,
  scene: SceneId,
  action: ActionId,
  chord: Chord,
): ActionId | null {
  for (const a of ACTIONS) {
    if (a.id === action) continue;
    const existing = map[scene][a.id];
    if (existing && chordEquals(existing, chord)) return a.id;
  }
  return null;
}

/**
 * 根据当前按下的物理键，解析某场景下激活的动作。
 * 竞争规则：同一主键上，只取具体程度（修饰键数量）最高的绑定；
 * 例如 E 与 Shift+E 同时满足时，只有 Shift+E 对应的动作激活。
 */
export function resolveActive(
  map: BindingMap,
  scene: SceneId,
  pressed: ReadonlySet<string>,
): Map<ActionId, Chord> {
  const satisfied: { action: ActionId; chord: Chord }[] = [];
  for (const a of ACTIONS) {
    const chord = map[scene][a.id];
    if (chord && chordSatisfied(chord, pressed)) satisfied.push({ action: a.id, chord });
  }
  const byCode = new Map<string, { action: ActionId; chord: Chord }[]>();
  for (const s of satisfied) {
    const list = byCode.get(s.chord.code) ?? [];
    list.push(s);
    byCode.set(s.chord.code, list);
  }
  const result = new Map<ActionId, Chord>();
  for (const group of byCode.values()) {
    let best = group[0];
    for (const g of group) {
      if (specificity(g.chord) > specificity(best.chord)) best = g;
    }
    result.set(best.action, best.chord);
  }
  return result;
}
