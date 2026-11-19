import { axialToOffset, hexDistance, offsetToAxial } from './hex';
import { GameMap, cellKey } from './map';
import { materialise, SCENARIOS, type ScenarioId, type ScenarioSpec } from './scenarios';
import type { CellExplanation, Enemy, Terrain, Unit, UnitId, ViewMode } from './types';
import { canStep, explainCell, VisionEngine } from './vision';

export interface SandboxOptions {
  scenarioId?: ScenarioId;
  mode?: ViewMode;
}

export type MoveFailure = 'not-selected' | 'not-adjacent' | 'blocked' | 'outside-map' | 'occupied';

export type MoveResult = { ok: true } | { ok: false; reason: MoveFailure };

export interface ExpectationResult {
  expect: 'visible' | 'hidden';
  col: number;
  row: number;
  actual: 'visible' | 'explored' | 'unexplored';
  ok: boolean;
  note: string;
}

/**
 * The whole application model. Framework-free and DOM-free so the test suite
 * can drive the real vision data instead of reading canvas colours.
 */
export class Sandbox {
  map: GameMap;
  units: Unit[];
  enemies: Enemy[];
  vision = new VisionEngine();
  mode: ViewMode;
  selectedUnit: UnitId | null = 'A';
  scenario: ScenarioSpec;
  /** Scouts pulled off the board, kept so the UI can put them back. */
  readonly withdrawn = new Map<UnitId, Unit>();

  constructor(options: SandboxOptions = {}) {
    this.mode = options.mode ?? 'player';
    this.scenario = SCENARIOS.find((s) => s.id === (options.scenarioId ?? 'sandbox')) ?? SCENARIOS[0]!;
    const state = materialise(this.scenario);
    this.map = state.map;
    this.units = state.units;
    this.enemies = state.enemies;
    this.vision.recompute(this.map, this.units);
  }

  loadScenario(id: ScenarioId): void {
    const spec = SCENARIOS.find((s) => s.id === id);
    if (!spec) throw new Error(`unknown scenario ${id}`);
    this.scenario = spec;
    const state = materialise(spec);
    this.map = state.map;
    this.units = state.units;
    this.enemies = state.enemies;
    this.selectedUnit = 'A';
    this.withdrawn.clear();
    this.vision.resetExplored();
    this.vision.recompute(this.map, this.units);
  }

  reset(): void {
    this.loadScenario(this.scenario.id);
  }

  selected(): Unit | null {
    return this.units.find((u) => u.id === this.selectedUnit) ?? null;
  }

  select(id: UnitId | null): void {
    this.selectedUnit = id;
  }

  /** Recompute after any change. Explored history is preserved. */
  refresh(): void {
    this.vision.recompute(this.map, this.units);
  }

  tryMoveSelectedTo(q: number, r: number): MoveResult {
    const unit = this.selected();
    if (!unit) return { ok: false, reason: 'not-selected' };
    return this.tryMoveUnit(unit.id, q, r);
  }

  tryMoveUnit(id: UnitId, q: number, r: number): MoveResult {
    const unit = this.units.find((u) => u.id === id);
    if (!unit) return { ok: false, reason: 'not-selected' };
    if (!this.map.isInsideMap(q, r)) return { ok: false, reason: 'outside-map' };
    if (hexDistance(unit.q, unit.r, q, r) !== 1) return { ok: false, reason: 'not-adjacent' };
    if (!canStep(this.map, unit, { q, r })) return { ok: false, reason: 'blocked' };
    if (this.units.some((u) => u.id !== id && u.q === q && u.r === r)) {
      return { ok: false, reason: 'occupied' };
    }
    unit.q = q;
    unit.r = r;
    this.refresh();
    return { ok: true };
  }

  setRadius(id: UnitId, radius: number): void {
    const unit = this.units.find((u) => u.id === id);
    if (!unit) return;
    unit.radius = Math.max(1, Math.min(12, Math.round(radius)));
    this.refresh();
  }

  toggleDoor(q: number, r: number): boolean {
    const changed = this.map.toggleDoor(q, r);
    if (changed) this.refresh();
    return changed;
  }

  setTerrain(q: number, r: number, terrain: Terrain): void {
    this.map.setTerrain(q, r, terrain);
    this.refresh();
  }

  /** Debug-only enemy repositioning. Returns false when the target is illegal. */
  moveEnemy(id: number, q: number, r: number): boolean {
    if (!this.map.isInsideMap(q, r)) return false;
    if (!this.map.isWalkable(q, r)) return false;
    const enemy = this.enemies.find((e) => e.id === id);
    if (!enemy) return false;
    if (this.units.some((u) => u.q === q && u.r === r)) return false;
    enemy.q = q;
    enemy.r = r;
    return true;
  }

  /** Player view: only enemies in currently visible cells. Debug sees all. */
  visibleEnemies(): Enemy[] {
    if (this.mode === 'debug') return this.enemies;
    return this.enemies.filter((e) => this.vision.isVisible(e.q, e.r));
  }

  /**
   * True when the cell is a door the player could plausibly know about: it is
   * currently visible, or it was remembered as a door from earlier exploration.
   * Used to gate door clicks in player view so an unseen door is not revealed
   * by click behaviour.
   */
  isDoorKnown(q: number, r: number): boolean {
    if (this.vision.isVisible(q, r)) return this.map.get(q, r)?.terrain === 'door';
    return this.vision.remembered(q, r)?.terrain === 'door';
  }

  /**
   * The only sanctioned way to read an enemy for picking / hover. In player and
   * edit modes a hidden enemy is indistinguishable from an empty cell.
   */
  enemyPickableAt(q: number, r: number): Enemy | null {
    if (this.mode === 'debug') return this.enemies.find((e) => e.q === q && e.r === r) ?? null;
    if (!this.vision.isVisible(q, r)) return null;
    return this.enemies.find((e) => e.q === q && e.r === r) ?? null;
  }

  hover(q: number, r: number): CellExplanation {
    return explainCell(this.map, this.units, this.vision, q, r);
  }

  /** Validates real per-cell vision data against the scenario's expectations. */
  expectations(): ExpectationResult[] {
    const out: ExpectationResult[] = [];
    for (const e of this.scenario.expectVisible) {
      out.push({ ...this.checkOne(e.col, e.row, 'visible'), note: e.note });
    }
    for (const e of this.scenario.expectHidden) {
      out.push({ ...this.checkOne(e.col, e.row, 'hidden'), note: e.note });
    }
    return out;
  }

  private checkOne(col: number, row: number, expect: 'visible' | 'hidden') {
    const { q, r } = offsetToAxial(col, row);
    let actual: 'visible' | 'explored' | 'unexplored';
    if (this.vision.isVisible(q, r)) actual = 'visible';
    else if (this.vision.isExplored(q, r)) actual = 'explored';
    else actual = 'unexplored';
    const ok = expect === 'visible' ? actual === 'visible' : actual !== 'visible';
    return { expect, col, row, actual, ok };
  }

  placeUnit(id: UnitId, q: number, r: number): void {
    const unit = this.units.find((u) => u.id === id);
    if (!unit || !this.map.isInsideMap(q, r)) return;
    unit.q = q;
    unit.r = r;
    this.refresh();
  }

  /**
   * Removes a unit from play, e.g. to prove that shared vision persists for the
   * other scout. Exploration memory is untouched.
   */
  withdrawUnit(id: UnitId): Unit | null {
    const index = this.units.findIndex((u) => u.id === id);
    if (index < 0) return this.withdrawn.get(id) ?? null;
    const [unit] = this.units.splice(index, 1);
    if (!unit) return null;
    this.withdrawn.set(id, unit);
    if (this.selectedUnit === id) this.selectedUnit = this.units[0]?.id ?? null;
    this.refresh();
    return unit;
  }

  /** Puts a withdrawn scout back at the position it left from. */
  restoreUnit(id: UnitId): Unit | null {
    const unit = this.withdrawn.get(id);
    if (!unit) return null;
    this.withdrawn.delete(id);
    this.units.push(unit);
    this.units.sort((a, b) => a.id.localeCompare(b.id));
    if (!this.selectedUnit) this.selectedUnit = unit.id;
    this.refresh();
    return unit;
  }

  isWithdrawn(id: UnitId): boolean {
    return this.withdrawn.has(id);
  }

  cellCoordinates(q: number, r: number): { q: number; r: number; col: number; row: number; key: string } {
    const { col, row } = axialToOffset(q, r);
    return { q, r, col, row, key: cellKey(q, r) };
  }
}
