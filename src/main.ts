import { DocumentStore } from './app/store';
import { Viewer } from './ui/viewer';
import { SAMPLES, buildSample, type SampleId } from './samples';
import type { MeshData, Vec3 } from './core/types';
import { analyzeGraph, boundaryLoops, buildGraph, edgeKey, validateMesh } from './core/topology';
import { compactMesh } from './core/mesh';
import { parseObj, writeObj } from './core/obj';
import {
  boundaryEdgeKeysWithin,
  boundaryLoopViews,
  candidateId,
  DEFAULT_SETTINGS,
  previewStitch,
  suggestExclusions,
  type BoundaryChain,
  type StitchPreview,
  type StitchSession,
} from './core/stitch';

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node as T;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n: number, digits = 4): string => {
  if (!Number.isFinite(n)) return '—';
  if (n !== 0 && Math.abs(n) < 0.001) return n.toExponential(2);
  return n.toFixed(digits).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m));
};

const fmtLen = (n: number): string => (n < 10 ? n.toFixed(4) : n.toFixed(2));

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

type Tool = 'orbit' | 'select';
type IssueTab = 'boundary' | 'nonmanifold' | 'orientation' | 'coincident';

class App {
  private readonly store: DocumentStore;
  private readonly viewer: Viewer;
  private readonly host: HTMLElement;
  private tool: Tool = 'orbit';
  private tab: IssueTab = 'boundary';
  private inspectedEdge: string | null = null;
  private lastGraph = null as unknown;
  private preview: StitchPreview | null = null;
  private previewDirty = true;
  private lastSession: StitchSession | null = null;
  /** 用户点过「预览变化」时的状态签名；配对/设置再变动即失效 */
  private approvedSignature: string | null = null;
  private toastTimer = 0;
  private selectionBox: HTMLElement;
  private dragStart: { x: number; y: number } | null = null;
  private dragging = false;
  /** 当前载入的样例；导入 OBJ 或重开导出后置空，避免样例卡片误显示为选中 */
  private activeSample: SampleId | null = 'cracked-panel';
  private verifying = false;
  private lastExportText: string | null = null;
  private pendingFit = true;

  constructor(store: DocumentStore) {
    this.store = store;
    this.host = must('canvas-host');
    this.viewer = new Viewer(this.host);
    this.selectionBox = must('selection-box');
    this.bindUi();
    this.store.subscribe(() => this.render());
    this.installCanvasInteractions();
    this.render();
    window.addEventListener('resize', () => this.viewer.resize());
  }

  /* ----------------------------- boot ----------------------------- */

  private bindUi(): void {
    must('file-input').addEventListener('change', (ev) => void this.onFile(ev));
    must('btn-export').addEventListener('click', () => this.onExport());
    must('btn-close-verify').addEventListener('click', () => {
      const d = must<HTMLDialogElement>('verify-dialog');
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    });
    must('btn-reopen-export').addEventListener('click', () => this.reopenExport());
    must('btn-verify').addEventListener('click', () => this.onVerify());
    must('btn-reset-view').addEventListener('click', () => this.viewer.fitCamera(this.store.mesh));
    must('btn-clear-selection').addEventListener('click', () => this.store.clearSelection());
    must('btn-swap-chains').addEventListener('click', () => this.store.swapChains());
    must('btn-focus-selection').addEventListener('click', () => this.focusSelection());
    must('btn-suggest').addEventListener('click', () => this.suggest());
    must('btn-clear-excluded').addEventListener('click', () => {
      const s = this.store.session;
      if (!s) return;
      s.excluded.clear();
      s.skipped.clear();
      this.previewDirty = true;
      this.store.refreshReport();
      this.toast('已恢复所有被剔除的候选与跳过的顶点', 'ok');
    });
    must('btn-preview').addEventListener('click', () => {
      this.previewDirty = true;
      this.render();
      const signature = this.previewSignature();
      this.approvedSignature = signature;
      this.renderPreview();
      this.renderOverlay();
      if (this.preview?.canApply) {
        this.toast(
          `预览已生成：影响 ${this.preview.weld?.affectedFaces.length ?? 0} 个面，写入前检查全部通过，可以确认合并。`,
          'ok',
        );
      } else {
        this.toast(
          `预览已生成，但写入前检查未通过：${this.preview?.blockedReasons.join('、') ?? '配对未就绪'}。`,
          'error',
        );
      }
    });
    must('btn-apply').addEventListener('click', () => this.apply());
    must('btn-undo').addEventListener('click', () => this.undo());
    must('tol-input').addEventListener('change', (ev) => {
      const v = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v >= 0) this.store.setReportTolerance(v);
    });
    must('stitch-tol').addEventListener('change', (ev) => {
      const v = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.store.setStitchTolerance(v);
        this.previewDirty = true;
        this.store.refreshReport();
      }
    });
    must('min-area').addEventListener('change', (ev) => {
      const v = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.store.settings.minAreaRatio = v;
        this.previewDirty = true;
        this.render();
      }
    });
    must('opposite-dot').addEventListener('change', (ev) => {
      const v = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v >= -1 && v <= 1) {
        this.store.settings.maxOppositeNormalDot = v;
        this.previewDirty = true;
        this.render();
      }
    });
    if (must('min-area') instanceof HTMLInputElement) {
      (must('min-area') as HTMLInputElement).value = String(DEFAULT_SETTINGS.minAreaRatio);
      (must('opposite-dot') as HTMLInputElement).value = String(DEFAULT_SETTINGS.maxOppositeNormalDot);
      (must('stitch-tol') as HTMLInputElement).value = String(DEFAULT_SETTINGS.tol);
    }

    const toolOrbit = must('tool-orbit');
    const toolSelect = must('tool-select');
    const setTool = (tool: Tool) => {
      this.tool = tool;
      toolOrbit.classList.toggle('active', tool === 'orbit');
      toolSelect.classList.toggle('active', tool === 'select');
      this.host.classList.toggle('selection-mode', tool === 'select');
      this.viewer.setRotateEnabled(tool === 'orbit');
    };
    toolOrbit.addEventListener('click', () => setTool('orbit'));
    toolSelect.addEventListener('click', () => setTool('select'));

    // issue tabs
    must('issue-tabs').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
      if (!btn) return;
      this.tab = btn.dataset.tab as IssueTab;
      for (const b of must('issue-tabs').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      this.renderIssues();
    });

    // event delegation for dynamic panels
    must('issue-list').addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-edge]');
      if (row?.dataset.edge) {
        this.inspectedEdge = row.dataset.edge;
        this.render();
      }
    });
    must('chain-box').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-chain]');
      if (!btn) return;
      const id = btn.dataset.chain!;
      const slot = btn.dataset.slot as 'A' | 'B';
      this.store.pickChain(slot, id);
    });
    must('conflict-list').addEventListener('click', (ev) => this.onConflictAction(ev));
    must('candidate-list').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-cand]');
      if (!btn) return;
      const session = this.store.session;
      if (!session) return;
      const id = btn.dataset.cand!;
      if (session.excluded.has(id)) session.excluded.delete(id);
      else session.excluded.add(id);
      this.previewDirty = true;
      this.store.refreshReport();
    });
    must('hole-list').addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-hole]');
      if (!btn) return;
      const key = btn.dataset.hole!;
      const currently = this.store.preservedHoles.has(key);
      this.store.togglePreservedHole(key, !currently);
    });
    must('post-report').addEventListener('click', () => {
      /* 仅展示 */
    });
    window.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        this.undo();
      } else if (ev.key === 'Escape') {
        this.store.clearSelection();
      }
    });
  }

  private installCanvasInteractions(): void {
    const canvas = this.viewer.renderer.domElement;
    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      this.dragStart = { x: ev.clientX, y: ev.clientY };
      this.dragging = false;
      if (this.tool === 'select') {
        canvas.setPointerCapture(ev.pointerId);
        this.selectionBox.classList.remove('hidden');
        this.updateSelectionBox(ev.clientX, ev.clientY, ev.clientX, ev.clientY);
      }
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!this.dragStart) return;
      const dx = ev.clientX - this.dragStart.x;
      const dy = ev.clientY - this.dragStart.y;
      if (!this.dragging && Math.hypot(dx, dy) > 4) this.dragging = true;
      if (this.dragging && this.tool === 'select') {
        this.updateSelectionBox(this.dragStart.x, this.dragStart.y, ev.clientX, ev.clientY);
      }
    });
    canvas.addEventListener('pointerup', (ev) => {
      if (!this.dragStart) return;
      const start = this.dragStart;
      this.dragStart = null;
      this.selectionBox.classList.add('hidden');
      if (this.dragging && this.tool === 'select') {
        this.applyBoxSelection(start.x, start.y, ev.clientX, ev.clientY, ev.shiftKey);
      } else if (!this.dragging) {
        const hit = this.viewer.pickEdge(ev.clientX, ev.clientY, 9);
        if (hit) {
          this.inspectedEdge = hit.key;
          this.render();
        }
      }
      this.dragging = false;
    });
    canvas.addEventListener('pointercancel', () => {
      this.dragStart = null;
      this.dragging = false;
      this.selectionBox.classList.add('hidden');
    });
  }

  private updateSelectionBox(x0: number, y0: number, x1: number, y1: number): void {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const left = Math.min(x0, x1) - hostRect.left;
    const top = Math.min(y0, y1) - hostRect.top;
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    void rect;
    Object.assign(this.selectionBox.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  private applyBoxSelection(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const hitKeys = this.viewer.edgesInScreenRect(x0, y0, x1, y1);
    if (hitKeys.length === 0) {
      this.toast('框选范围内没有边。请把矩形拖在接缝上再试。', 'error');
      return;
    }
    const keys = hitKeys.filter((k) => this.store.graph.edges.get(k)?.cls === 'boundary');
    if (keys.length === 0) {
      this.toast(`框选到 ${hitKeys.length} 条边，但没有自由边。只有自由边可以参与补缝。`, 'error');
      return;
    }
    // 追加框选（Shift）：与已有选择合并；否则替换
    const nextKeys = additive ? [...new Set([...this.store.selection.keys, ...keys])] : keys;
    this.store.setSelectionKeys(nextKeys);
    const chains = this.store.selection.chains.length;
    if (chains === 0) {
      this.toast('框选到的自由边没有连成可用的边界段。', 'error');
    } else if (chains === 1) {
      this.toast(`框选到 ${keys.length} 条自由边，组成 1 段链。请再把接缝另一侧也框进来。`, 'error');
    } else {
      this.toast(`框选到 ${keys.length} 条自由边，组成 ${chains} 段链`, 'ok');
    }
    this.inspectedEdge = null;
  }

  /* ----------------------------- actions ----------------------------- */

  private onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const MAX_BYTES = 24 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      this.toast(`文件 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_BYTES / 1024 / 1024} MB 上限。本工具面向小网格。`, 'error');
      input.value = '';
      return;
    }
    void file.text().then((text) => {
      const parsed = parseObj(text);
      if (!parsed.mesh.indices.length) {
        this.toast(`OBJ 中没有可用的三角形${parsed.errors[0] ? '：' + parsed.errors[0] : ''}`, 'error');
        return;
      }
      const validation = validateMesh(parsed.mesh);
      if (!validation.ok) {
        this.toast(`OBJ 结构无效：${validation.errors[0]}${validation.errors.length > 1 ? ' 等' : ''}`, 'error');
        return;
      }
      this.lastGraph = null;
      this.pendingFit = true;
      this.preview = null;
      this.previewDirty = true;
      this.inspectedEdge = null;
      this.activeSample = null;
      this.store.loadMesh(parsed.mesh, file.name);
      const warn = parsed.errors.length
        ? `解析有 ${parsed.errors.length} 个错误已跳过`
        : parsed.warnings.length
          ? parsed.warnings.join('；')
          : '';
      this.toast(`已导入 ${file.name}：${parsed.mesh.indices.length / 3} 个面${warn ? ' · ' + warn : ''}`, warn ? 'error' : 'ok');
      input.value = '';
    });
  }

  private suggest(): void {
    const s = this.store.session;
    if (!s) return;
    const ids = suggestExclusions(s);
    if (ids.length === 0) {
      this.toast('没有需要剔除的候选：每个顶点都只有一个候选。', 'ok');
      return;
    }
    for (const id of ids) s.excluded.add(id);
    this.previewDirty = true;
    this.store.refreshReport();
    this.toast(`已按最近距离剔除 ${ids.length} 个候选；剩余冲突需要人工确认。`, 'ok');
  }

  private onConflictAction(ev: Event): void {
    const target = ev.target as HTMLElement;
    const session = this.store.session;
    if (!session) return;
    const excludeId = target.closest<HTMLElement>('[data-exclude]')?.dataset.exclude;
    if (excludeId) {
      session.excluded.add(excludeId);
      this.previewDirty = true;
      this.store.refreshReport();
      return;
    }
    const skipV = target.closest<HTMLElement>('[data-skip]')?.dataset.skip;
    if (skipV !== undefined) {
      const v = Number(skipV);
      if (session.skipped.has(v)) session.skipped.delete(v);
      else session.skipped.add(v);
      this.previewDirty = true;
      this.store.refreshReport();
    }
  }

  apply(): void {
    const session = this.store.session;
    if (!session || !this.preview || !this.preview.canApply || !this.preview.weld) {
      this.toast('还没有通过写入前检查的预览，不能合并。', 'error');
      return;
    }
    if (!this.isPreviewApproved()) {
      this.toast('配对或设置已变化，请先点「预览变化」确认当前状态，再合并。', 'error');
      return;
    }
    const a = session.chainA.vertices.slice();
    const b = session.chainB.vertices.slice();
    const weld = this.preview.weld;
    const pairs = this.preview.pairs.length;
    const record = this.store.applyWeld({
      newMesh: weld.mesh,
      weldedVertices: weld.weldedAway.slice(),
      removedFaces: weld.removedFaces.slice(),
      pairs,
      chainA: a,
      chainB: b,
      label: `补缝 ${pairs} 对顶点`,
      representative: weld.representative,
    });
    this.lastGraph = this.store.graph;
    this.preview = null;
    this.previewDirty = true;
    this.approvedSignature = null;
    this.inspectedEdge = null;
    this.toast(
      `已合并：焊接 ${record.weldedVertices.length} 个顶点，自由边 ${record.beforeBoundary} → ${record.afterBoundary}。可按 Cmd/Ctrl+Z 或点「撤销」回退。`,
      'ok',
    );
  }

  undo(): void {
    const ok = this.store.undoLast();
    if (!ok) {
      this.toast('没有可撤销的修补。', 'error');
      return;
    }
    this.lastGraph = this.store.graph;
    this.preview = null;
    this.previewDirty = true;
    this.approvedSignature = null;
    this.inspectedEdge = null;
    this.toast('已撤销这次修补：顶点位置、编号关系、保留标记和选择状态都已恢复。', 'ok');
  }

  private exportMesh(): { mesh: MeshData; removed: number } {
    const compact = compactMesh(this.store.mesh);
    return { mesh: compact.mesh, removed: compact.removedVertices.length };
  }

  getExportText(): string {
    return this.exportText();
  }

  getPreview(): StitchPreview | null {
    return this.preview;
  }

  private exportText(): string {
    const { mesh } = this.exportMesh();
    return writeObj(mesh, {
      header: [
        `source: ${this.store.sourceName}`,
        `stitch history: ${this.store.history.length} 次`,
        'exported after topology check; unused vertices compacted',
      ],
      objectName: 'mesh',
    });
  }

  private onExport(): void {
    const text = this.exportText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stitched-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.obj`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const { removed } = this.exportMesh();
    this.toast(`已导出 OBJ${removed ? `（压缩 ${removed} 个未引用顶点）` : ''}`, 'ok');
  }

  private onVerify(): void {
    if (this.verifying) return;
    this.verifying = true;
    try {
      const text = this.exportText();
      this.lastExportText = text;
      const parsed = parseObj(text);
      const before = this.store.report;
      const reopenedGraph = buildGraph(parsed.mesh);
      const after = analyzeGraph(reopenedGraph, this.store.reportTol);
      const rows: [string, string, string][] = [
        ['顶点数', String(before.referencedVertexCount), String(after.vertexCount)],
        ['三角形数', String(before.faceCount), String(after.faceCount)],
        ['边数', String(before.edgeCount), String(after.edgeCount)],
        ['自由边', String(before.boundaryEdges.length), String(after.boundaryEdges.length)],
        ['邻面 > 2 的边', String(before.nonManifoldEdges.length), String(after.nonManifoldEdges.length)],
        ['朝向冲突', String(before.orientationIssues.length), String(after.orientationIssues.length)],
        ['独立外壳', String(before.shellCount), String(after.shellCount)],
      ];
      const same = rows.every(([, a, b]) => a === b) && parsed.errors.length === 0;
      const body = must('verify-body');
      body.innerHTML = `
        <div class="verify-banner ${same ? 'ok' : 'bad'}">
          ${same ? '✓ 重新打开后的拓扑与导出前一致' : '✗ 重新打开后的拓扑与导出前不一致，请检查下方差异'}
        </div>
        <div class="verify-grid">
          <div class="verify-card">
            <h3>导出前（当前文档）</h3>
            ${rows.map(([k, a]) => `<div class="verify-line"><span>${esc(k)}</span><b>${a}</b></div>`).join('')}
          </div>
          <div class="verify-card">
            <h3>重新打开后（解析 OBJ）</h3>
            ${rows
              .map(
                ([k, a, b]) =>
                  `<div class="verify-line"><span>${esc(k)}</span><b style="color:${
                    a === b ? 'inherit' : 'var(--danger)'
                  }">${b}</b></div>`,
              )
              .join('')}
          </div>
        </div>
        <div class="verify-note">
          导出时压缩了未引用顶点，因此顶点编号会重新排列，但拓扑关系（面数、自由边、非流形边、朝向冲突、外壳数）必须保持一致。
          ${parsed.errors.length ? `<br><span style="color:var(--danger)">解析错误：${esc(parsed.errors.slice(0, 4).join('；'))}</span>` : ''}
          ${parsed.warnings.length ? `<br>解析提示：${esc(parsed.warnings.join('；'))}` : ''}
        </div>`;
      const dialog = must<HTMLDialogElement>('verify-dialog');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } finally {
      this.verifying = false;
    }
  }

  /** 把刚才导出的 OBJ 文本重新解析并载入，作为“导出→重开”闭环的第二步。 */
  private reopenExport(): void {
    const text = this.lastExportText;
    const dialog = must<HTMLDialogElement>('verify-dialog');
    if (!text) {
      this.toast('还没有导出内容可载入。', 'error');
      return;
    }
    const parsed = parseObj(text);
    const validation = validateMesh(parsed.mesh);
    if (!parsed.mesh.indices.length || !validation.ok) {
      this.toast('导出内容解析失败，无法重新载入。', 'error');
      return;
    }
    this.activeSample = null;
    this.preview = null;
    this.previewDirty = true;
    this.inspectedEdge = null;
    this.lastGraph = null;
    this.pendingFit = true;
    this.store.loadMesh(parsed.mesh, '重新打开:导出结果.obj');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    const r = this.store.report;
    this.toast(
      `已重新载入导出结果：${r.faceCount} 面 · 自由边 ${r.boundaryEdges.length} · 非流形边 ${r.nonManifoldEdges.length} · 朝向冲突 ${r.orientationIssues.length} · 外壳 ${r.shellCount}`,
      'ok',
    );
  }

  private focusSelection(): void {
    const g = this.store.graph;
    const chains = [this.store.getChainA(), this.store.getChainB()].filter(Boolean) as BoundaryChain[];
    if (chains.length === 0) return;
    const pts: Vec3[] = [];
    for (const c of chains) for (const v of c.vertices) pts.push(g.points[v]);
    this.viewer.focusOn(pts);
  }

  /* ----------------------------- render ----------------------------- */

  private render(): void {
    if (this.store.graph !== this.lastGraph) {
      this.lastGraph = this.store.graph;
      this.viewer.setMesh(this.store.mesh, this.store.graph, this.pendingFit);
      this.pendingFit = false;
      syncToleranceInputs(this.store);
    }
    this.computePreviewIfNeeded();
    this.renderStats();
    this.renderIssues();
    this.renderInspector();
    this.renderChains();
    this.renderPairing();
    this.renderPreview();
    this.renderPost();
    this.renderOverlay();
    this.renderSamples();
  }

  private computePreviewIfNeeded(): void {
    const session = this.store.session;
    if (!session) {
      this.preview = null;
      this.lastSession = null;
      return;
    }
    if (this.preview && !this.previewDirty && this.lastSession === session) return;
    this.preview = previewStitch(this.store.graph, session, this.store.settings, this.store.report);
    this.previewDirty = false;
    this.lastSession = session;
  }

  /**
   * 预览审批签名：网格、两段链、已剔除候选、跳过顶点与阈值任一变化都会失效，
   * 从而强制用户重新「预览变化」后才能「确认合并」。
   */
  private previewSignature(): string | null {
    const session = this.store.session;
    if (!session) return null;
    const s = this.store.settings;
    return [
      this.graphSerial(this.store.graph),
      session.chainA.id,
      session.chainB.id,
      [...session.excluded].sort().join(';'),
      [...session.skipped].sort((a, b) => a - b).join(','),
      s.tol,
      s.minAreaRatio,
      s.maxOppositeNormalDot,
      s.maxNormalOffsetRatio,
      this.store.reportTol,
    ].join('|');
  }

  private graphSerials = new WeakMap<object, number>();
  private graphSerialCounter = 0;
  private graphSerial(graph: object): number {
    let n = this.graphSerials.get(graph);
    if (n === undefined) {
      n = ++this.graphSerialCounter;
      this.graphSerials.set(graph, n);
    }
    return n;
  }

  private isPreviewApproved(): boolean {
    return this.approvedSignature !== null && this.approvedSignature === this.previewSignature();
  }

  private renderSamples(): void {
    const list = must('sample-list');
    list.innerHTML = SAMPLES.map(
      (s) => `
      <button class="sample-item ${s.id === this.activeSample ? 'active' : ''}" data-sample="${s.id}">
        <div class="name">
          <span>${esc(s.name)}</span>
          <span class="tag ${s.id === 'double-layer' ? 'bad' : 'ok'}">${s.id === 'double-layer' ? '禁止合并' : '可演示'}</span>
        </div>
        <div class="desc">${esc(s.description)}</div>
      </button>`,
    ).join('');
    if (!list.dataset.bound) {
      list.dataset.bound = '1';
      list.addEventListener('click', (ev) => {
        const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-sample]');
        if (!btn) return;
        const id = btn.dataset.sample as SampleId;
        this.loadSample(id);
      });
    }
  }

  loadSample(id: SampleId): void {
    this.activeSample = id;
    const mesh = buildSample(id);
    this.preview = null;
    this.previewDirty = true;
    this.inspectedEdge = null;
    // 先把容差写入（此时还指向旧网格，不会重建视图），再强制换网格并重新取景
    this.store.setStitchTolerance(SAMPLE_TOL[id]);
    this.lastGraph = null;
    this.pendingFit = true;
    this.store.loadMesh(mesh, `内置样例:${id}`);
    const info = SAMPLES.find((s) => s.id === id);
    this.toast(`${info?.name ?? id}：${info?.expectation ?? ''}`, 'ok');
  }

  private renderStats(): void {
    const report = this.store.report;
    const cells: [string, string, string][] = [
      ['顶点 (已用/总数)', `${report.referencedVertexCount} / ${report.vertexCount}`, ''],
      ['三角形', String(report.faceCount), ''],
      ['边', String(report.edgeCount), ''],
      ['独立外壳', String(report.shellCount), report.shellCount > 1 ? 'warn' : 'ok'],
      ['自由边', String(report.boundaryEdges.length), report.boundaryEdges.length ? 'warn' : 'ok'],
      [
        '邻面 > 2 的边',
        String(report.nonManifoldEdges.length),
        report.nonManifoldEdges.length ? 'danger' : 'ok',
      ],
      ['朝向冲突', String(report.orientationIssues.length), report.orientationIssues.length ? 'danger' : 'ok'],
      [
        '几何重合顶点组',
        String(report.coincidentVertexGroups.length),
        report.coincidentVertexGroups.length ? 'warn' : '',
      ],
    ];
    const extra =
      report.unusedVertexCount > 0
        ? `<div class="hint">有 ${report.unusedVertexCount} 个未被面引用的顶点（焊接后保留编号所致，导出时会压缩）。</div>`
        : '';
    must('mesh-stats').innerHTML =
      cells
        .map(
          ([k, v, cls]) =>
            `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`,
        )
        .join('') + extra;
  }

  private renderIssues(): void {
    const report = this.store.report;
    const list = must('issue-list');
    const rows: string[] = [];
    if (this.tab === 'boundary') {
      const loops = boundaryLoops(this.store.graph);
      const loopOf = new Map<string, number>();
      loops.forEach((verts, i) => {
        for (let j = 0; j + 1 < verts.length; j++) loopOf.set(edgeKey(verts[j], verts[j + 1]), i);
        if (verts.length >= 3) loopOf.set(edgeKey(verts[verts.length - 1], verts[0]), i);
      });
      for (const e of report.boundaryEdges.slice(0, 300)) {
        const k = edgeKey(e.a, e.b);
        const li = loopOf.get(k);
        rows.push(
          `<div class="issue-row ${this.inspectedEdge === k ? 'selected' : ''}" data-edge="${k}">
            <span>v${e.a} — v${e.b}</span>
            <span class="badge boundary">自由边${li !== undefined ? ` · 环 ${li + 1}` : ''}</span>
          </div>`,
        );
      }
      if (report.boundaryEdges.length === 0) rows.push('<div class="empty">没有自由边：网格在该判定下是闭合的。</div>');
      else if (report.boundaryEdges.length > 300)
        rows.push(`<div class="empty">仅显示前 300 条，共 ${report.boundaryEdges.length} 条。</div>`);
    } else if (this.tab === 'nonmanifold') {
      for (const e of report.nonManifoldEdges) {
        const k = edgeKey(e.a, e.b);
        rows.push(
          `<div class="issue-row ${this.inspectedEdge === k ? 'selected' : ''}" data-edge="${k}">
            <span>v${e.a} — v${e.b}</span>
            <span class="badge nonmanifold">${e.faces.length} 个面</span>
          </div>`,
        );
      }
      if (rows.length === 0) rows.push('<div class="empty">没有超过 2 个邻面的边。</div>');
    } else if (this.tab === 'orientation') {
      for (const o of report.orientationIssues) {
        const k = edgeKey(o.edge.a, o.edge.b);
        rows.push(
          `<div class="issue-row ${this.inspectedEdge === k ? 'selected' : ''}" data-edge="${k}">
            <span>v${o.edge.a} — v${o.edge.b}</span>
            <span class="badge orientation">${o.faces.map((f) => `#${f}`).join(' ')}</span>
          </div>`,
        );
      }
      if (rows.length === 0) rows.push('<div class="empty">没有发现同向使用同一条边的面。</div>');
    } else {
      const groups = report.coincidentVertexGroups;
      for (const group of groups.slice(0, 200)) {
        const dist = group.length >= 2 ? this.pairwiseMaxDistance(group) : 0;
        rows.push(
          `<div class="issue-row" data-group="${group.join(',')}" title="几何重合，但索引不同">
            <span>v${group.join(', v')}</span>
            <span class="badge coincident">≤ ${fmt(dist)}</span>
          </div>`,
        );
      }
      if (groups.length === 0) rows.push('<div class="empty">没有几何重合但索引不同的顶点。</div>');
      else
        rows.push(
          `<div class="empty">这些顶点坐标在容差内重合，但编号不同 → 拓扑上并没有连接。合并需要显式焊接。</div>`,
        );
    }
    list.innerHTML = rows.join('');
  }

  private pairwiseMaxDistance(group: number[]): number {
    const pts = this.store.graph.points;
    let max = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = pts[group[i]];
        const b = pts[group[j]];
        max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      }
    }
    return max;
  }

  private renderInspector(): void {
    const box = must('edge-inspector');
    const key = this.inspectedEdge;
    if (!key) {
      box.className = 'inspector muted';
      box.textContent = '在视图里点击任意一条边，查看它实际连接了哪些面。';
      return;
    }
    const g = this.store.graph;
    const e = g.edges.get(key);
    if (!e) {
      box.className = 'inspector muted';
      box.textContent = '该边已不存在（网格已变化）。';
      return;
    }
    box.className = 'inspector';
    const kind = e.cls === 'boundary' ? '自由边（1 个面）' : e.cls === 'manifold' ? '共享边（2 个面）' : `非流形边（${e.faces.length} 个面）`;
    const parts: string[] = [];
    parts.push(`<div class="row"><span class="kv">边</span><b>v${e.a} — v${e.b}</b></div>`);
    parts.push(`<div class="row"><span class="kv">类别</span><b>${esc(kind)}</b></div>`);
    parts.push(`<div class="row"><span class="kv">长度</span><b>${fmtLen(Math.hypot(g.points[e.a].x - g.points[e.b].x, g.points[e.a].y - g.points[e.b].y, g.points[e.a].z - g.points[e.b].z))}</b></div>`);

    // 共享顶点说明
    const shared = e.faces.length > 1;
    parts.push(
      `<div class="row"><span class="kv">共享顶点</span><b style="color:${shared ? 'var(--ok)' : 'var(--text-dim)'}">${
        shared ? `是：${e.faces.length} 个面都引用 v${e.a}、v${e.b}（索引相同）` : '否：只有一个面引用，另一侧没有面'
      }</b></div>`,
    );

    parts.push(`<div class="kv" style="margin-top:6px">实际连接的面：</div>`);
    for (const f of e.faces) {
      const a = g.indices[f * 3];
      const b = g.indices[f * 3 + 1];
      const c = g.indices[f * 3 + 2];
      const n = g.faceNormals[f];
      const nl = Math.hypot(n.x, n.y, n.z);
      const dir = this.directedUse(f, e.a, e.b);
      parts.push(
        `<div class="face-item">
          <div>面 #${f} → 顶点 (${a}, ${b}, ${c})</div>
          <div>法线 (${fmt(n.x / nl)}, ${fmt(n.y / nl)}, ${fmt(n.z / nl)}) · 面积 ${fmt(g.faceAreas[f], 5)}</div>
          <div>沿边方向 ${dir ?? '—'}</div>
        </div>`,
      );
    }

    if (e.faces.length === 2) {
      const d0 = this.directedUse(e.faces[0], e.a, e.b);
      const d1 = this.directedUse(e.faces[1], e.a, e.b);
      const same = d0 !== null && d0 === d1;
      parts.push(
        `<div class="row" style="margin-top:5px"><span class="kv">朝向</span><b style="color:${
          same ? 'var(--danger)' : 'var(--ok)'
        }">${same ? '两个面同向使用该边 → 朝向冲突' : '两个面反向使用该边 → 朝向一致'}</b></div>`,
      );
    }

    // 端点上的几何重合顶点（直接读拓扑报告里的重合组，避免逐顶点全表扫描）
    const groupOf = this.coincidentGroupByVertex();
    for (const v of [e.a, e.b]) {
      const group = groupOf.get(v);
      const others: { id: number; d: number }[] = [];
      if (group) {
        for (const o of group) {
          if (o === v) continue;
          const d = Math.hypot(
            g.points[o].x - g.points[v].x,
            g.points[o].y - g.points[v].y,
            g.points[o].z - g.points[v].z,
          );
          others.push({ id: o, d });
        }
      }
      if (others.length > 0) {
        others.sort((x, y) => x.d - y.d);
        const desc = others
          .slice(0, 6)
          .map((o) => `v${o.id} (${fmt(o.d)})`)
          .join('、');
        parts.push(
          `<div class="row" style="margin-top:5px"><span class="kv">几何重合</span><b style="color:var(--warn)">v${v} ≈ ${desc} — 索引不同，拓扑上未连接</b></div>`,
        );
      }
    }
    const loopInfo = this.loopForEdge(key);
    if (loopInfo) parts.push(`<div class="row"><span class="kv">所属边界环</span><b>${loopInfo}</b></div>`);
    box.innerHTML = parts.join('');
  }

  private coincidentGroupByVertex(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (const group of this.store.report.coincidentVertexGroups) {
      for (const v of group) map.set(v, group);
    }
    return map;
  }

  private directedUse(face: number, a: number, b: number): string | null {
    const g = this.store.graph;
    const k = edgeKey(a, b);
    const tri = [g.indices[face * 3], g.indices[face * 3 + 1], g.indices[face * 3 + 2]];
    for (let i = 0; i < 3; i++) {
      const u = tri[i];
      const w = tri[(i + 1) % 3];
      if (edgeKey(u, w) === k) return `${u} → ${w}`;
    }
    return null;
  }

  private loopForEdge(key: string): string | null {
    const loops = boundaryLoops(this.store.graph);
    for (let i = 0; i < loops.length; i++) {
      const verts = loops[i];
      const keys: string[] = [];
      for (let j = 0; j + 1 < verts.length; j++) keys.push(edgeKey(verts[j], verts[j + 1]));
      if (verts.length >= 3) keys.push(edgeKey(verts[verts.length - 1], verts[0]));
      if (keys.includes(key)) return `#${i + 1}（${verts.length} 个顶点）`;
    }
    return null;
  }

  private renderChains(): void {
    const sel = this.store.selection;
    const a = this.store.getChainA();
    const b = this.store.getChainB();
    const cardA = must('chain-card-a');
    const cardB = must('chain-card-b');
    const chainHtml = (chain: BoundaryChain | null): string => {
      if (!chain) return '<div class="chain-body muted">尚未选择</div>';
      return `<div class="chain-body">
        ${chain.vertices.length} 个顶点 · ${chain.closed ? '闭环（不能直接缝合）' : '开口'} · 长 ${fmtLen(chain.length)}
        <br>v${chain.vertices.join(' → v')}
      </div>`;
    };
    cardA.className = 'chain-card a';
    cardB.className = 'chain-card b';
    cardA.querySelector('.chain-body')?.remove();
    cardB.querySelector('.chain-body')?.remove();
    cardA.insertAdjacentHTML('beforeend', chainHtml(a));
    cardB.insertAdjacentHTML('beforeend', chainHtml(b));

    let picker = document.getElementById('chain-picker');
    if (sel.chains.length > 2) {
      if (!picker) {
        picker = document.createElement('div');
        picker.id = 'chain-picker';
        picker.className = 'list-title';
        must('chain-box').appendChild(picker);
      }
      picker.innerHTML =
        `框选里共有 ${sel.chains.length} 段边界，请指定 A / B：` +
        sel.chains
          .map(
            (c, i) => `<div class="cand-row">
              <span>#${i + 1} · ${c.vertices.length} 点 · ${c.closed ? '闭环' : '开口'}</span>
              <span class="ops">
                <button class="mini-btn" data-chain="${c.id}" data-slot="A">设为 A</button>
                <button class="mini-btn" data-chain="${c.id}" data-slot="B">设为 B</button>
              </span>
            </div>`,
          )
          .join('');
      picker.style.display = '';
    } else if (picker) {
      picker.innerHTML = '';
      picker.style.display = 'none';
    }
  }

  private renderPairing(): void {
    const session = this.store.session;
    const summary = must('pairing-summary');
    const conflicts = must('conflict-list');
    const candidates = must('candidate-list');
    if (!session) {
      summary.className = 'summary muted';
      summary.textContent = '选择两段边界后自动计算候选点。';
      conflicts.innerHTML = '';
      candidates.innerHTML = '';
      return;
    }
    summary.className = 'summary';
    const active = session.candidates.filter((c) => !session.excluded.has(candidateId(c.a, c.b)));
    const preview = this.preview;
    const pairing = preview ? preview.pairs : [];
    const ready = !!preview && preview.conflicts.length === 0 && preview.pairs.length > 0;
    summary.innerHTML = `
      A 段 ${session.chainA.vertices.length} 点 · B 段 ${session.chainB.vertices.length} 点 ·
      候选 ${session.candidates.length} 组（已剔除 ${session.excluded.size}，跳过 ${session.skipped.size} 点）·
      容差 ${fmtLen(session.tol)}<br>
      <span class="${ready ? 'ok' : 'bad'}">${
        ready
          ? `已唯一配对 ${pairing.length} 组，可以预览`
          : `冲突 ${preview?.conflicts.length ?? 0} 个，暂不能配对`
      }</span>`;
    if (session.issues.length) {
      conflicts.innerHTML = session.issues
        .map(
          (m) => `<div class="conflict"><div class="head"><span class="pill chain">无法配对</span></div><div class="msg">${esc(m)}</div></div>`,
        )
        .join('');
    } else if (preview) {
      conflicts.innerHTML = preview.conflicts
        .map((c) => {
          const cbs = (c.candidates ?? [])
            .map(
              (p) =>
                `<button class="mini-btn" data-exclude="${candidateId(p.a, p.b)}">剔除 v${p.a}↔v${p.b}</button>`,
            )
            .join('');
          const skip = c.vertex !== undefined ? `<button class="mini-btn danger" data-skip="${c.vertex}">跳过 v${c.vertex}</button>` : '';
          return `<div class="conflict">
            <div class="head"><span class="pill ${c.kind}">${
              c.kind === 'missing' ? '缺少对应点' : c.kind === 'ambiguous' ? '多候选' : c.kind === 'crossing' ? '配对交叉' : '无法配对'
            }</span><span>${c.side} 段</span></div>
            <div class="msg">${esc(c.message)}</div>
            ${cbs || skip ? `<div class="actions">${cbs}${skip}</div>` : ''}
          </div>`;
        })
        .join('');
      if (preview.conflicts.length === 0 && !ready) {
        conflicts.innerHTML = '<div class="empty">没有冲突；等待配对结果。</div>';
      }
    }

    if (session.candidates.length === 0) {
      candidates.innerHTML = `<div class="empty">容差内没有任何对应点。请增大配对容差，或确认两段边界是否是同一接缝的两侧。</div>`;
      return;
    }
    const activeIds = new Set(active.map((c) => candidateId(c.a, c.b)));
    candidates.innerHTML =
      `<div class="list-title">候选点（${active.length}/${session.candidates.length} 生效）</div>` +
      session.candidates
        .slice(0, 200)
        .map((c) => {
          const id = candidateId(c.a, c.b);
          const excluded = session.excluded.has(id);
          const used = preview?.pairs.some((p) => candidateId(p.a, p.b) === id);
          return `<div class="cand-row ${excluded ? 'excluded' : ''}">
            <span>v${c.a} ↔ v${c.b}${used ? ' ✓' : ''}</span>
            <span class="dist">${fmt(c.distance)}</span>
            <span class="ops"><button class="mini-btn ${excluded ? '' : 'danger'}" data-cand="${id}">${
              excluded ? '恢复' : '剔除'
            }</button></span>
          </div>`;
        })
        .join('') +
      (session.candidates.length > 200 ? `<div class="empty">仅显示前 200 组。</div>` : '') +
      (activeIds.size === 0 ? '<div class="empty">所有候选都被剔除。</div>' : '');
  }

  private renderPreview(): void {
    const checksBox = must('preview-checks');
    const preview = this.preview;
    const btnPreview = must<HTMLButtonElement>('btn-preview');
    const btnApply = must<HTMLButtonElement>('btn-apply');
    const hint = must('apply-hint');
    const session = this.store.session;
    btnPreview.disabled = !session;
    if (!preview || !session) {
      checksBox.className = 'checks muted';
      checksBox.textContent = '配对就绪后显示写入前检查。';
      btnApply.disabled = true;
      hint.textContent = '';
      return;
    }
    checksBox.className = 'checks';
    const icon: Record<string, string> = { pass: '✓', warn: '!', fail: '✕' };
    // 注意：下方 checks 只是实时试算；真正写入还要求 approvedSignature 与当前状态一致。
    const affected = preview.weld?.affectedFaces.length ?? 0;
    const delta = preview.delta;
    const deltaText =
      preview.after !== undefined
        ? `影响 ${affected} 个面 · 焊接 ${preview.weld?.weldedAway.length ?? 0} 个顶点 · 最大位移 ${fmt(
            preview.maxDisplacement,
            5,
          )} · 自由边 ${delta.boundaryEdges >= 0 ? '+' : ''}${delta.boundaryEdges} · 外壳 ${delta.shells >= 0 ? '+' : ''}${delta.shells}`
        : '';
    checksBox.innerHTML =
      (deltaText ? `<div class="summary muted" style="margin-bottom:4px">${esc(deltaText)}</div>` : '') +
      preview.checks
        .map(
          (c) => `<div class="check ${c.status}">
            <span class="icon">${icon[c.status]}</span>
            <div><div class="label">${esc(c.label)}</div><div class="detail">${esc(c.detail)}</div></div>
          </div>`,
        )
        .join('');
    const approved = this.isPreviewApproved();
    btnApply.disabled = !(preview.canApply && approved);
    if (!preview.canApply) {
      hint.innerHTML = `<span style="color:var(--danger)">已阻断：${esc(preview.blockedReasons.join('、'))}。该组不会写入。</span>`;
    } else if (!approved) {
      hint.innerHTML = `<span style="color:var(--warn)">检查通过；请先点「预览变化」确认当前状态，再确认合并。</span>`;
      btnPreview.classList.add('attention');
    } else {
      hint.innerHTML = `<span style="color:var(--ok)">预览已确认，可以写入。</span>`;
    }
    if (approved) btnPreview.classList.remove('attention');
    btnPreview.disabled = false;
  }

  private renderPost(): void {
    const box = must('post-report');
    const holeBox = must('hole-list');
    const undoBtn = must<HTMLButtonElement>('btn-undo');
    const historyBox = must('history-list');
    const report = this.store.report;
    const loops = boundaryLoopViews(this.store.graph, this.store.preservedHoles);
    const preservedCount = loops.filter((l) => l.preserved).length;
    box.className = 'summary';
    box.innerHTML = `
      <div class="row">自由边 <b>${report.boundaryEdges.length}</b> 条 · 边界环 <b>${loops.length}</b> 个</div>
      <div class="row">朝向冲突 <b style="color:${report.orientationIssues.length ? 'var(--danger)' : 'var(--ok)'}">${report.orientationIssues.length}</b> 处</div>
      <div class="row">邻面 &gt; 2 的边 <b style="color:${report.nonManifoldEdges.length ? 'var(--danger)' : 'var(--ok)'}">${report.nonManifoldEdges.length}</b> 条</div>
      <div class="row">独立外壳 <b>${report.shellCount}</b> 个</div>
      <div class="row">有意保留的洞 <b style="color:${preservedCount ? 'var(--ok)' : 'var(--text-dim)'}">${preservedCount}</b> 个</div>
      ${this.store.history.length ? '' : '<div class="hint">尚未合并。完成一次合并后，这里会显示合并后的复查结果。</div>'}`;
    if (loops.length === 0) {
      holeBox.innerHTML = '<div class="empty">没有边界环，网格闭合。</div>';
    } else {
      holeBox.innerHTML =
        `<div class="list-title">边界环（点击切换“有意保留”）</div>` +
        loops
          .map(
            (l) => `<div class="hole-row ${l.preserved ? 'preserved' : ''}">
            <span>${l.closed ? '闭环' : '开口'} · ${l.vertices.length} 点 · 长 ${fmtLen(l.length)}</span>
            <button class="mini-btn" data-hole="${esc(l.key)}">${l.preserved ? '✓ 已保留' : '标记为保留'}</button>
          </div>`,
          )
          .join('');
    }
    undoBtn.disabled = !this.store.canUndo();
    historyBox.innerHTML = this.store.history.length
      ? `<div class="list-title">修补记录</div>` +
        this.store.history
          .map(
            (r) =>
              `<div class="history-row"><span class="time">${new Date(r.time).toLocaleTimeString('zh-CN', {
                hour12: false,
              })}</span> · ${esc(r.label)}<br>焊接 ${r.weldedVertices.length} 点 · 删除 ${r.removedFaces.length} 面 · 自由边 ${r.beforeBoundary}→${r.afterBoundary} · 容差 ${fmtLen(r.tol)}</div>`,
          )
          .join('')
      : '';
  }

  private renderOverlay(): void {
    const g = this.store.graph;
    const report = this.store.report;
    const preservedKeys = new Set<string>();
    for (const loop of boundaryLoopViews(g, this.store.preservedHoles)) {
      if (loop.preserved) for (const k of loop.edges) preservedKeys.add(k);
    }
    const boundaryEdges = report.boundaryEdges.map((e) => edgeKey(e.a, e.b)).filter((k) => !preservedKeys.has(k));
    const a = this.store.getChainA();
    const b = this.store.getChainB();
    const sel = this.store.selection;
    const usedA = new Set(a?.edgeKeys ?? []);
    const usedB = new Set(b?.edgeKeys ?? []);
    const candidateEdges = sel.keys.filter((k) => !usedA.has(k) && !usedB.has(k) && g.edges.get(k)?.cls === 'boundary');
    const session = this.store.session;
    const pairSegments: [number, number][] = [];
    if (session) {
      const active = session.candidates.filter((c) => !session.excluded.has(candidateId(c.a, c.b)));
      for (const c of active.slice(0, 2000)) pairSegments.push([c.a, c.b]);
    }
    this.viewer.setOverlay({
      boundaryEdges,
      nonManifoldEdges: report.nonManifoldEdges.map((e) => edgeKey(e.a, e.b)),
      orientationEdges: report.orientationIssues.map((o) => edgeKey(o.edge.a, o.edge.b)),
      candidateEdges,
      chainAEdges: a?.edgeKeys ?? [],
      chainBEdges: b?.edgeKeys ?? [],
      preservedEdges: [...preservedKeys],
      inspectedEdges: this.inspectedEdge ? [this.inspectedEdge] : [],
      chainAVertices: a?.vertices ?? [],
      chainBVertices: b?.vertices ?? [],
      pairSegments,
      previewFaces: this.preview?.weld?.affectedFaces ?? [],
    });
  }

  private toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
    const el = must('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.add('hidden'), 5200);
    el.classList.remove('hidden');
  }
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

const SAMPLE_TOL: Record<SampleId, number> = {
  'cracked-panel': 0.05,
  'double-layer': 0.01,
  'open-box': 0.01,
  'torn-sheet': 0.14,
  'bad-topology': 0.01,
};

function syncToleranceInputs(store: DocumentStore): void {
  const stitchTol = document.getElementById('stitch-tol') as HTMLInputElement | null;
  if (stitchTol) stitchTol.value = String(store.settings.tol);
  const reportTol = document.getElementById('tol-input') as HTMLInputElement | null;
  if (reportTol) reportTol.value = String(store.reportTol);
}

const store = new DocumentStore(buildSample('cracked-panel'));
store.setStitchTolerance(SAMPLE_TOL['cracked-panel']);
const app = new App(store);

// 自动化验证钩子：浏览器控制台可直接调用；不参与业务逻辑。
declare global {
  interface Window {
    __seamInspector?: {
      store: DocumentStore;
      app: unknown;
      selectSample: (id: SampleId) => void;
      selectByWorldBox: (min: Vec3, max: Vec3) => void;
      apply: () => void;
      undo: () => void;
      preview: () => StitchPreview | null;
      exportText: () => string;
    };
  }
}
window.__seamInspector = {
  store,
  app,
  selectSample: (id: SampleId) => app.loadSample(id),
  selectByWorldBox: (min: Vec3, max: Vec3) => {
    const keys = boundaryEdgeKeysWithin(store.graph, min, max);
    store.setSelectionKeys(keys);
  },
  apply: () => app.apply(),
  undo: () => app.undo(),
  preview: () => app.getPreview(),
  exportText: () => app.getExportText(),
};
