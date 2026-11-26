import type { Project, Segment } from '../core/types';
import { createExampleProject } from '../core/project';
import { makeId } from '../core/timeline';

const STORAGE_KEY = 'beat-sheet-project-v1';

type Listener = () => void;

/**
 * 单一工程状态。试听与 WAV 导出读的是同一份 project.settings,
 * 加上 localStorage 持久化, 保证快速编辑、暂停恢复后两边设置始终一致。
 */
class ProjectStore {
  project: Project;
  private listeners = new Set<Listener>();

  constructor() {
    this.project = this.load() ?? createExampleProject();
  }

  private load(): Project | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Project;
      if (!parsed.segments?.length || !parsed.settings) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
    } catch {
      /* 存储满或禁用时忽略 */
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.save();
    this.listeners.forEach((fn) => fn());
  }

  update(mutator: (p: Project) => void): void {
    mutator(this.project);
    this.emit();
  }

  updateSegment(id: string, mutator: (s: Segment) => void): void {
    this.update((p) => {
      const s = p.segments.find((x) => x.id === id);
      if (s) mutator(s);
    });
  }

  addSegment(index?: number): void {
    this.update((p) => {
      const at = index ?? p.segments.length;
      const prev = p.segments[Math.min(at, p.segments.length - 1)];
      const fallback: Segment = {
        id: makeId(),
        label: '新段',
        meter: { numerator: 4, denominator: 4 },
        bars: 2,
        pickupBeats: 0,
        subdivision: 2,
        mode: 'constant',
        bpmStart: 100,
        bpmEnd: 100,
      };
      const template: Segment = prev ? structuredClone(prev) : fallback;
      template.id = makeId();
      template.pickupBeats = 0;
      template.label = `${template.label} 副本`;
      p.segments.splice(at, 0, template);
    });
  }

  removeSegment(id: string): void {
    this.update((p) => {
      if (p.segments.length <= 1) return;
      p.segments = p.segments.filter((s) => s.id !== id);
    });
  }

  moveSegment(id: string, dir: -1 | 1): void {
    this.update((p) => {
      const i = p.segments.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.segments.length) return;
      [p.segments[i], p.segments[j]] = [p.segments[j], p.segments[i]];
    });
  }

  loadExample(): void {
    this.project = createExampleProject();
    this.emit();
  }

  exportJson(): string {
    return JSON.stringify(this.project, null, 2);
  }

  importJson(raw: string): void {
    const parsed = JSON.parse(raw) as Project;
    if (!parsed.segments?.length || !parsed.settings) {
      throw new Error('工程文件格式不正确');
    }
    this.project = parsed;
    this.emit();
  }
}

export const store = new ProjectStore();
