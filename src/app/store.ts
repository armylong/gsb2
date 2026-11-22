import type { MeshData, TopologyReport } from '../core/types';
import { analyzeGraph, buildGraph, type MeshGraph } from '../core/topology';
import { cloneMesh } from '../core/mesh';
import {
  buildChains,
  candidateId,
  createSession,
  DEFAULT_SETTINGS,
  type BoundaryChain,
  type StitchSession,
  type StitchSettings,
} from '../core/stitch';

export interface StitchRecord {
  id: string;
  time: number;
  label: string;
  chainAVertices: number[];
  chainBVertices: number[];
  weldedVertices: number[];
  removedFaces: number[];
  pairs: number;
  tol: number;
  beforeBoundary: number;
  afterBoundary: number;
}

/** 一次修补的完整快照，用于撤销时逐位恢复。 */
interface Snapshot {
  mesh: MeshData;
  preserved: Set<string>;
  selection: SelectionState;
  report: TopologyReport;
  settings: StitchSettings;
  reportTol: number;
}

export interface SelectionState {
  keys: string[];
  chains: BoundaryChain[];
  chainAId: string | null;
  chainBId: string | null;
}

const EMPTY_SELECTION: SelectionState = { keys: [], chains: [], chainAId: null, chainBId: null };

export class DocumentStore {
  mesh: MeshData;
  graph: MeshGraph;
  report: TopologyReport;
  settings: StitchSettings = { ...DEFAULT_SETTINGS };
  /** 几何重合提示容差（只影响报告里的 coincidentVertexGroups） */
  reportTol = 0.01;
  selection: SelectionState = { ...EMPTY_SELECTION };
  session: StitchSession | null = null;
  preservedHoles = new Set<string>();
  history: StitchRecord[] = [];
  private snapshots: Snapshot[] = [];
  private listeners = new Set<() => void>();
  sourceName = '未命名';

  constructor(mesh: MeshData) {
    this.mesh = cloneMesh(mesh);
    this.graph = buildGraph(this.mesh);
    this.report = analyzeGraph(this.graph, this.reportTol);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  loadMesh(mesh: MeshData, name: string): void {
    this.mesh = cloneMesh(mesh);
    this.graph = buildGraph(this.mesh);
    this.selection = { ...EMPTY_SELECTION };
    this.session = null;
    this.preservedHoles.clear();
    this.history = [];
    this.snapshots = [];
    this.sourceName = name;
    this.report = analyzeGraph(this.graph, this.reportTol);
    this.emit();
  }

  setReportTolerance(tol: number): void {
    this.reportTol = Math.max(0, tol);
    this.report = analyzeGraph(this.graph, this.reportTol);
    this.emit();
  }

  setStitchTolerance(tol: number): void {
    this.settings.tol = Math.max(1e-6, tol);
    if (this.session) {
      const prevExcluded = new Set(this.session.excluded);
      const prevSkipped = new Set(this.session.skipped);
      this.session = createSession(this.graph, this.session.chainA, this.session.chainB, this.settings.tol);
      // 容差变化会改变候选集合：保留仍然存在的剔除项与跳过点，避免用户工作丢失
      const valid = new Set(this.session.candidates.map((c) => candidateId(c.a, c.b)));
      for (const id of prevExcluded) if (valid.has(id)) this.session.excluded.add(id);
      for (const v of prevSkipped) {
        if (
          this.session.chainA.vertices.includes(v) ||
          this.session.chainB.vertices.includes(v)
        ) {
          this.session.skipped.add(v);
        }
      }
    }
    this.emit();
  }

  setSelectionKeys(keys: string[]): void {
    const chains = buildChains(this.graph, keys);
    const sorted = [...chains].sort((a, b) => a.vertices[0] - b.vertices[0]);
    let chainAId: string | null = null;
    let chainBId: string | null = null;
    if (sorted.length === 1) chainAId = sorted[0].id;
    else if (sorted.length >= 2) {
      // 自动配对：选“互相最靠近、长度较接近”的两段，避免把同一侧被矩形切开的
      // 短片段误当成另一侧。用户仍可在面板里手动改为 A / B。
      const pair = this.bestChainPair(sorted);
      chainAId = pair[0];
      chainBId = pair[1];
    }
    this.selection = { keys, chains: sorted, chainAId, chainBId };
    this.rebuildSession();
    this.emit();
  }

  private bestChainPair(chains: BoundaryChain[]): [string, string] {
    const g = this.graph;
    /** 两段链之间最近的一对顶点距离 */
    const nearest = (a: BoundaryChain, b: BoundaryChain): number => {
      let best = Infinity;
      for (const va of a.vertices) {
        const pa = g.points[va];
        for (const vb of b.vertices) {
          const pb = g.points[vb];
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
          if (d < best) best = d;
        }
      }
      return best;
    };
    let bestI = 0;
    let bestJ = 1;
    let bestScore = Infinity;
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const d = nearest(chains[i], chains[j]);
        const ratio =
          Math.min(chains[i].length, chains[j].length) / Math.max(chains[i].length, chains[j].length, 1e-9);
        const score = d + (1 - ratio) * d;
        if (score < bestScore) {
          bestScore = score;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const a = chains[bestI];
    const b = chains[bestJ];
    return a.vertices[0] <= b.vertices[0] ? [a.id, b.id] : [b.id, a.id];
  }

  swapChains(): void {
    const { chainAId, chainBId } = this.selection;
    if (!chainAId || !chainBId) return;
    this.selection.chainAId = chainBId;
    this.selection.chainBId = chainAId;
    this.rebuildSession();
    this.emit();
  }

  pickChain(slot: 'A' | 'B', id: string): void {
    if (slot === 'A') {
      if (this.selection.chainBId === id) this.selection.chainBId = this.selection.chainAId;
      this.selection.chainAId = id;
    } else {
      if (this.selection.chainAId === id) this.selection.chainAId = this.selection.chainBId;
      this.selection.chainBId = id;
    }
    this.rebuildSession();
    this.emit();
  }

  clearSelection(): void {
    this.selection = { ...EMPTY_SELECTION };
    this.session = null;
    this.emit();
  }

  getChainA(): BoundaryChain | null {
    if (!this.selection.chainAId) return null;
    return this.selection.chains.find((c) => c.id === this.selection.chainAId) ?? null;
  }

  getChainB(): BoundaryChain | null {
    if (!this.selection.chainBId) return null;
    return this.selection.chains.find((c) => c.id === this.selection.chainBId) ?? null;
  }

  private rebuildSession(): void {
    const a = this.getChainA();
    const b = this.getChainB();
    this.session = a && b ? createSession(this.graph, a, b, this.settings.tol) : null;
  }

  /** 应用一组焊接结果，并记录完整快照。返回记录。 */
  applyWeld(params: {
    newMesh: MeshData;
    weldedVertices: number[];
    removedFaces: number[];
    pairs: number;
    chainA: number[];
    chainB: number[];
    label: string;
    /** 旧顶点 -> 代表点；用于把“有意保留的洞”映射到合并后的编号 */
    representative?: Int32Array;
  }): StitchRecord {
    const snapshot: Snapshot = {
      mesh: cloneMesh(this.mesh),
      preserved: new Set(this.preservedHoles),
      selection: {
        keys: [...this.selection.keys],
        chains: this.selection.chains.map((c) => ({ ...c, vertices: [...c.vertices], edgeKeys: [...c.edgeKeys] })),
        chainAId: this.selection.chainAId,
        chainBId: this.selection.chainBId,
      },
      report: this.report,
      settings: { ...this.settings },
      reportTol: this.reportTol,
    };
    this.snapshots.push(snapshot);
    this.mesh = cloneMesh(params.newMesh);
    this.graph = buildGraph(this.mesh);
    this.report = analyzeGraph(this.graph, this.reportTol);

    // 保留标记按顶点编号集合存储；焊接后顶点编号不压缩，但成员可能被并入代表点，
    // 因此用 representative 重写 key，保证“有意保留的洞”不会因补缝而丢失。
    if (params.representative) {
      const rep = params.representative;
      const remapped = new Set<string>();
      for (const key of this.preservedHoles) {
        const ids = key
          .split(',')
          .map(Number)
          .filter((v) => Number.isInteger(v) && v >= 0 && v < rep.length)
          .map((v) => rep[v]);
        remapped.add([...new Set(ids)].sort((a, b) => a - b).join(','));
      }
      this.preservedHoles = remapped;
    }

    const record: StitchRecord = {
      id: `stitch-${this.history.length + 1}`,
      time: Date.now(),
      label: params.label,
      chainAVertices: params.chainA,
      chainBVertices: params.chainB,
      weldedVertices: params.weldedVertices,
      removedFaces: params.removedFaces,
      pairs: params.pairs,
      tol: this.settings.tol,
      beforeBoundary: snapshot.report.boundaryEdges.length,
      afterBoundary: this.report.boundaryEdges.length,
    };
    this.history.push(record);
    this.selection = { ...EMPTY_SELECTION };
    this.session = null;
    this.emit();
    return record;
  }

  canUndo(): boolean {
    return this.snapshots.length > 0;
  }

  /** 撤销最近一次修补：位置、索引关系、保留洞标记与历史一起回退。 */
  undoLast(): boolean {
    const snapshot = this.snapshots.pop();
    if (!snapshot) return false;
    this.mesh = cloneMesh(snapshot.mesh);
    this.graph = buildGraph(this.mesh);
    this.report = snapshot.report;
    this.preservedHoles = new Set(snapshot.preserved);
    this.settings = { ...snapshot.settings };
    this.reportTol = snapshot.reportTol;
    this.selection = {
      keys: [...snapshot.selection.keys],
      chains: snapshot.selection.chains.map((c) => ({ ...c, vertices: [...c.vertices], edgeKeys: [...c.edgeKeys] })),
      chainAId: snapshot.selection.chainAId,
      chainBId: snapshot.selection.chainBId,
    };
    this.history.pop();
    this.rebuildSession();
    this.emit();
    return true;
  }

  togglePreservedHole(key: string, preserved: boolean): void {
    if (preserved) this.preservedHoles.add(key);
    else this.preservedHoles.delete(key);
    this.emit();
  }

  refreshReport(): void {
    this.report = analyzeGraph(this.graph, this.reportTol);
    this.emit();
  }

  /** 只读快照，供导出/验证使用。 */
  snapshotMesh(): MeshData {
    return cloneMesh(this.mesh);
  }
}
