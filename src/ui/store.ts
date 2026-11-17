/** 应用共享状态：所有视图共用同一份路径与样式，保证对照入口完全同参数 */
import { Vec2 } from '../core/math2d';
import { PolyPath } from '../core/path';
import { buildStrokeMesh, StrokeMeshData } from '../core/mesh';
import { StrokeOptions, DEFAULT_STROKE } from '../core/types';
import { DashOptions, DEFAULT_DASH } from '../core/dash';
import { SAMPLES } from '../core/samples';

export interface AppState {
  points: Vec2[];
  closed: boolean;
  stroke: StrokeOptions;
  dash: DashOptions;
}

export interface Derived {
  path: PolyPath;
  mesh: StrokeMeshData | null;
  totalLength: number;
}

type Listener = (s: AppState, d: Derived) => void;

export class AppStore {
  state: AppState = {
    points: SAMPLES[1].points.map((p) => ({ ...p })),
    closed: SAMPLES[1].closed,
    stroke: { ...DEFAULT_STROKE },
    dash: { ...DEFAULT_DASH },
  };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  derive(): Derived {
    const path = new PolyPath(this.state.points, this.state.closed);
    const { mesh, totalLength } = buildStrokeMesh(this.state.points, this.state.closed, this.state.stroke, this.state.dash);
    return { path, mesh, totalLength };
  }

  private emit(): void {
    const d = this.derive();
    for (const fn of this.listeners) fn(this.state, d);
  }

  update(mut: (s: AppState) => void): void {
    mut(this.state);
    this.emit();
  }

  loadSample(id: string): void {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s) return;
    this.update((st) => {
      st.points = s.points.map((p) => ({ ...p }));
      st.closed = s.closed;
    });
  }

  addPoint(p: Vec2): void {
    this.update((st) => st.points.push({ ...p }));
  }

  moveVertex(index: number, p: Vec2): void {
    this.update((st) => {
      if (st.points[index]) st.points[index] = { ...p };
    });
  }

  deleteVertex(index: number): void {
    this.update((st) => {
      if (st.points.length <= 2) return; // 保留最少两个点
      st.points.splice(index, 1);
    });
  }

  toggleClosed(): void {
    this.update((st) => {
      st.closed = !st.closed;
    });
  }
}
