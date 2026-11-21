import { analyzeMap } from '../core/analyzer';
import { applyEdit, deserializeMap, serializeMap, type EditRecord, type MapEdit } from '../core/editor';
import { generateMap, type GenParams } from '../core/generator';
import { buildScenarios } from '../core/scenarios';
import { Player } from '../core/player';
import type { GameMap, LockAnalysis, Route, RouteStep } from '../core/types';

export type Tool = 'inspect' | 'moveKey' | 'door' | 'corridor';

interface SaveFile {
  kind: 'lockdown-dungeon-save';
  version: 1;
  savedAt: string;
  params: GenParams;
  map: ReturnType<typeof serializeMap>;
  edits: EditRecord[];
}

const STORAGE_KEY = 'ldc-save-v1';

export class AppState {
  params: GenParams = { seed: 'demo-seed', roomCount: 12, colorCount: 1 };
  map: GameMap;
  analysis: LockAnalysis;
  editStack: GameMap[] = [];
  edits: EditRecord[] = [];
  tool: Tool = 'inspect';
  selectedKeyId: number | null = null;
  player: Player | null = null;
  routeCursor = -1;
  playTimer: number | null = null;
  scenarioId: string | null = null;
  /** 订阅者:任何状态变化后重绘 */
  private listeners = new Set<() => void>();

  constructor() {
    const first = generateMap(this.params);
    if (!first.ok || !first.map) throw new Error(first.error ?? '初始生成失败');
    this.map = first.map;
    this.analysis = analyzeMap(this.map);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  get route(): Route | null {
    return this.analysis.route;
  }

  // ---------- 生成与现场 ----------

  regenerate(params: GenParams): { ok: boolean; error: string | null } {
    this.stopPlayback();
    const res = generateMap(params);
    if (!res.ok || !res.map) return { ok: false, error: res.error };
    this.params = { ...params };
    this.map = res.map;
    this.analysis = analyzeMap(this.map);
    this.editStack = [];
    this.edits = [];
    this.selectedKeyId = null;
    this.scenarioId = null;
    this.resetMarkers();
    this.emit();
    return { ok: true, error: null };
  }

  loadScenario(id: string): void {
    this.stopPlayback();
    const scene = buildScenarios().find((s) => s.id === id);
    if (!scene) return;
    this.map = scene.map;
    this.analysis = analyzeMap(this.map);
    this.params = { seed: scene.map.seed, roomCount: scene.map.roomCount, colorCount: scene.map.colorCount };
    this.editStack = [];
    this.edits = [];
    this.selectedKeyId = null;
    this.scenarioId = id;
    this.resetMarkers();
    this.emit();
  }

  // ---------- 人工修改:旧路线与可达标记立即失效并重算 ----------

  doEdit(edit: MapEdit, note: string): { ok: boolean; error: string | null } {
    try {
      this.stopPlayback();
      this.editStack.push(this.map);
      const { map: next, note: autoNote } = applyEdit(this.map, edit);
      this.map = next;
      this.analysis = analyzeMap(this.map); // 立即重新检查
      this.edits.push({ ...edit, at: new Date().toLocaleTimeString(), note: note || autoNote });
      this.selectedKeyId = null;
      this.resetMarkers();
      this.emit();
      return { ok: true, error: null };
    } catch (e) {
      this.editStack.pop();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  undo(): void {
    const prev = this.editStack.pop();
    if (!prev) return;
    this.stopPlayback();
    this.map = prev;
    this.analysis = analyzeMap(this.map);
    this.edits.pop();
    this.selectedKeyId = null;
    this.resetMarkers();
    this.emit();
  }

  get canUndo(): boolean {
    return this.editStack.length > 0;
  }

  // ---------- 玩家标记与路线播放 ----------

  resetMarkers(): void {
    this.stopPlayback();
    this.player = null;
    this.routeCursor = -1;
  }

  ensurePlayer(): Player {
    if (!this.player) this.player = new Player(this.map);
    return this.player;
  }

  manualMove(dx: number, dy: number): { ok: boolean; message: string } {
    this.stopPlayback();
    const p = this.ensurePlayer();
    const res = p.move(dx, dy);
    this.routeCursor = -1; // 手动移动后退出路线播放,标记位置为准
    this.emit();
    if (!res.ok) return { ok: false, message: res.blockedReason ?? '无法移动' };
    if (res.openedDoorId !== null) return { ok: true, message: `打开门 #${res.openedDoorId}` };
    if (res.pickedKeyId !== null) return { ok: true, message: `拾取钥匙 #${res.pickedKeyId}` };
    if (p.atExit) return { ok: true, message: '已到达出口!' };
    return { ok: true, message: '' };
  }

  playRouteStep(): boolean {
    if (!this.route) return false;
    if (!this.player) {
      this.player = new Player(this.map);
      this.routeCursor = 0;
    }
    const next = this.routeCursor + 1;
    if (next >= this.route.steps.length) {
      this.stopPlayback();
      return false;
    }
    const target = this.route.steps[next];
    const cur = this.route.steps[this.routeCursor];
    const res = this.player.move(target.x - cur.x, target.y - cur.y);
    if (!res.ok) {
      this.stopPlayback();
      this.emit();
      throw new Error(`路线第 ${next} 步非法:${res.blockedReason}`);
    }
    this.routeCursor = next;
    this.emit();
    return next < this.route.steps.length - 1;
  }

  startPlayback(): void {
    if (!this.route) return;
    this.stopPlayback();
    this.player = new Player(this.map);
    this.routeCursor = 0;
    this.emit();
    this.playTimer = window.setInterval(() => {
      try {
        const more = this.playRouteStep();
        if (!more) this.stopPlayback();
      } catch (e) {
        this.stopPlayback();
        this.emit();
        throw e;
      }
    }, 160);
  }

  stopPlayback(): void {
    if (this.playTimer !== null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  get isPlaying(): boolean {
    return this.playTimer !== null;
  }

  /** 当前应展示的逐步事件(路线播放时取路线事件,手动时取玩家历史) */
  visibleEvents(): { text: string; kind: 'pick' | 'open' | 'normal'; current: boolean }[] {
    if (this.route && this.routeCursor >= 0) {
      return this.route.events.map((text, i) => ({
        text,
        kind: text.includes('拾取') ? 'pick' : text.includes('打开') ? 'open' : 'normal',
        current: i === this.routeCursor,
      }));
    }
    if (this.player) {
      const out: { text: string; kind: 'pick' | 'open' | 'normal'; current: boolean }[] = [];
      for (const s of this.player.history) {
        if (s.pickedKeyId !== null) {
          const k = this.map.keys.find((kk) => kk.id === s.pickedKeyId);
          out.push({ text: `第 ${s.index} 步:拾取${k ? `钥匙 #${k.id}` : '钥匙'}`, kind: 'pick', current: false });
        }
        if (s.openedDoorId !== null) {
          out.push({ text: `第 ${s.index} 步:打开门 #${s.openedDoorId}`, kind: 'open', current: false });
        }
      }
      return out;
    }
    return [];
  }

  playerHistory(): RouteStep[] {
    return this.player?.history ?? [];
  }

  // ---------- 保存 / 恢复 ----------

  saveToStorage(): string {
    const data: SaveFile = {
      kind: 'lockdown-dungeon-save',
      version: 1,
      savedAt: new Date().toISOString(),
      params: { ...this.params },
      map: serializeMap(this.map),
      edits: this.edits.map((e) => ({ ...e })),
    };
    const text = JSON.stringify(data, null, 2);
    localStorage.setItem(STORAGE_KEY, text);
    return text;
  }

  exportFile(): void {
    const text = this.saveToStorage();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dungeon-layout-${this.params.seed}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  loadFromText(text: string): { ok: boolean; error: string | null } {
    try {
      const data = JSON.parse(text) as SaveFile;
      if (data.kind !== 'lockdown-dungeon-save' || data.version !== 1) {
        return { ok: false, error: '存档格式不匹配' };
      }
      this.stopPlayback();
      this.map = deserializeMap(data.map);
      this.params = { ...data.params };
      this.edits = data.edits ?? [];
      // 编辑历史无法完整重建,但地图本身已含全部修改;清空撤销栈并如实说明
      this.editStack = [];
      this.analysis = analyzeMap(this.map);
      this.selectedKeyId = null;
      this.scenarioId = null;
      this.resetMarkers();
      this.emit();
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  loadFromStorage(): { ok: boolean; error: string | null } {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return { ok: false, error: '浏览器中没有已保存的存档' };
    return this.loadFromText(text);
  }

  hasStorageSave(): boolean {
    return localStorage.getItem(STORAGE_KEY) !== null;
  }
}
