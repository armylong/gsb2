import { Euler } from 'three';
import {
  CAPACITY_PRESETS,
  DEFAULT_OBJECT_COUNT,
  DEFAULT_SEED,
  buildRayBatch,
  demoRays,
  generateScene,
  resetObjects,
} from './core/scene';
import {
  buildBvh,
  comparePick,
  objectAabb,
  pickBrute,
  pickWithBvh,
  sameOutcome,
  type Bvh,
} from './core/picking';
import { rayHitsBox } from './core/geometry';
import type {
  CapBatchReport,
  GeneratedScene,
  PickOutcome,
  RaySpec,
  SceneObject,
} from './core/types';
import { SceneViewer, type GizmoMode } from './view/SceneViewer';

// ---------------------------------------------------------------------------
// 轻量 DOM 工具
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node as T;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

function setStatus(
  id: string,
  kind: 'neutral' | 'good' | 'warning' | 'critical',
  text: string,
): void {
  const node = el(id);
  node.className = `status status-${kind}`;
  node.textContent = text;
}

// ---------------------------------------------------------------------------
// 应用状态
// ---------------------------------------------------------------------------

type Mode = 'inspect' | 'edit';

interface AppState {
  scene: GeneratedScene;
  objectsById: Map<number, SceneObject>;
  bvh: Bvh;
  capacity: number;
  dirty: boolean;
  mode: Mode;
  rayBatch: RaySpec[];
  currentRay: RaySpec | null;
  pick: {
    accelerated: PickOutcome;
    brute: PickOutcome;
    candidateGroups: Map<number, number>;
    stale: boolean;
  } | null;
  batch: CapBatchReport[] | null;
  editId: number | null;
}

const canvas = el<HTMLCanvasElement>('view');

let state: AppState;

const viewer = new SceneViewer(canvas, {
  onCanvasPick: (origin, direction) => {
    if (state.mode === 'edit') {
      const id = viewer.pickObjectId(origin, direction);
      selectForEdit(id);
      return;
    }
    runPick({
      origin,
      direction,
      label: '屏幕点选',
      tag: 'screen',
    });
  },
  onTransformStart: () => {
    // 拖动手柄时避免误触发画布点选；这里不改变状态
  },
  onObjectChange: () => {
    viewer.syncObjectsFromCore();
    markDirty();
  },
  onTransformEnd: () => {
    viewer.syncObjectsFromCore();
    markDirty();
    refreshEditMeta();
  },
});

// ---------------------------------------------------------------------------
// 初始化 / 场景重建
// ---------------------------------------------------------------------------

function loadScene(seed: number): void {
  const scene = generateScene(seed, DEFAULT_OBJECT_COUNT);
  const objectsById = new Map(scene.objects.map((o) => [o.id, o]));
  state = {
    scene,
    objectsById,
    bvh: buildBvh(scene.objects, 8),
    capacity: 8,
    dirty: false,
    mode: 'inspect',
    rayBatch: buildRayBatch(scene, 200),
    currentRay: null,
    pick: null,
    batch: null,
    editId: null,
  };

  viewer.loadScene(scene);
  viewer.setEditEnabled(false);
  setMode('inspect');
  setCapacity(8, false);
  refreshGroupStats();
  refreshSpecials();
  renderRayButtons();
  clearPickPanel();
  clearBatchPanel();
  el<HTMLInputElement>('seed-input').value = String(seed);
  el('dirty-banner').classList.add('hidden');
  viewer.clearPick();
  viewer.setHighlight(null);
  viewer.setTransformTarget(null);
  redrawGroups();
}

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

function rebuildBvh(): void {
  state.bvh = buildBvh(state.scene.objects, state.capacity);
  state.dirty = false;
}

function redrawGroups(visited: number[] = []): void {
  const showAll = el<HTMLInputElement>('show-groups').checked;
  const visitedSet = new Set(visited);
  const visitedLeaves = state.bvh.leaves.filter((leaf) => visitedSet.has(leaf.id));
  viewer.drawGroups(showAll ? state.bvh.leaves : null, visitedLeaves);
}

function setCapacity(capacity: number, rerun = true): void {
  state.capacity = capacity;
  rebuildBvh();
  renderCapacityChips();
  refreshGroupStats();
  redrawGroups(state.pick?.accelerated.visitedGroupIds ?? []);
  updateDirtyBanner();
  if (rerun && state.currentRay) runPick(state.currentRay);
}

function renderCapacityChips(): void {
  const host = el('capacity-chips');
  host.innerHTML = '';
  for (const cap of CAPACITY_PRESETS) {
    const btn = document.createElement('button');
    btn.className = `chip${cap === state.capacity ? ' active' : ''}`;
    btn.textContent = String(cap);
    btn.title = `每个叶组最多 ${cap} 件物件`;
    btn.addEventListener('click', () => setCapacity(cap));
    host.appendChild(btn);
  }
}

function refreshGroupStats(): void {
  setText('stat-groups', String(state.bvh.leaves.length));
  setText('stat-depth', String(state.bvh.maxDepth));
  setText('stat-objects', String(state.scene.objects.length));
  const stateNode = el('stat-state');
  if (state.dirty) {
    stateNode.textContent = '过期';
    stateNode.style.color = 'var(--warning)';
  } else {
    stateNode.textContent = '有效';
    stateNode.style.color = 'var(--good)';
  }
}

function markDirty(): void {
  if (state.dirty) {
    // 仍在拖动，刷新统计与提示即可
    updateDirtyBanner();
    return;
  }
  state.dirty = true;
  refreshGroupStats();
  updateDirtyBanner();
  if (state.currentRay) runPick(state.currentRay);
  refreshSpecials();
  // 批次结果基于旧分组，标记为需重跑
  if (state.batch) {
    setStatus('batch-badge', 'warning', '需重跑');
    setText('batch-detail', '物件已变换，下方结果为变换前的快照。');
  }
}

function updateDirtyBanner(): void {
  el('dirty-banner').classList.toggle('hidden', !state.dirty);
}

function updateGroupsNow(): void {
  rebuildBvh();
  refreshGroupStats();
  updateDirtyBanner();
  redrawGroups(state.pick?.accelerated.visitedGroupIds ?? []);
  if (state.currentRay) runPick(state.currentRay);
  refreshSpecials();
  if (state.batch) {
    setStatus('batch-badge', 'neutral', '分组已更新');
    setText('batch-detail', '请重新运行核查以采用新分组。');
  }
}

// ---------------------------------------------------------------------------
// 点选
// ---------------------------------------------------------------------------

function clearPickPanel(): void {
  state.pick = null;
  state.currentRay = null;
  setText('kpi-candidates', '—');
  setText('kpi-candidates-foot', '进入精确求交');
  setText('kpi-brute', '—');
  setText('kpi-hits', '—');
  setText('kpi-hits-foot', 't ≥ 0 的交点');
  setText('kpi-groups', '—');
  setText('kpi-groups-foot', '命中包围盒的叶组');
  setText('kpi-selected', '—');
  setText('kpi-selected-foot', '按统一裁决规则');
  el('kpi-hits').classList.remove('is-hit');
  el('kpi-selected').classList.remove('is-selected');
  el('kpi-candidates').classList.remove('is-candidate');
  el('ray-meta').textContent = '还没有发射射线。单击 3D 场景，或选择上方演示射线。';
  el('ray-meta').classList.add('muted');
  setStatus('agree-badge', 'neutral', '等待射线');
  setText('agree-detail', '加速路径与逐件求交将逐条对照');
  setText('group-note', '—');
  el('group-list').innerHTML =
    '<div class="group-empty">发射一条射线后，这里按组列出进入求交的件数。</div>';
  el('candidate-table').querySelector('tbody')!.innerHTML =
    '<tr><td colspan="4" class="muted">—</td></tr>';
  setText('candidate-note', '—');
}

function rayToDisplay(ray: RaySpec): string {
  const o = ray.origin;
  const d = ray.direction;
  return `${ray.label}\norigin (${fmt(o.x, 1)}, ${fmt(o.y, 1)}, ${fmt(o.z, 1)})  dir (${fmt(
    d.x,
    2,
  )}, ${fmt(d.y, 2)}, ${fmt(d.z, 2)})`;
}

function runPick(ray: RaySpec, frame = false): void {
  state.currentRay = ray;

  const objectsById = state.objectsById;
  const accelerated = pickWithBvh(state.bvh, objectsById, ray.origin, ray.direction);
  const brute = pickBrute(state.scene.objects, ray.origin, ray.direction);
  const stale = state.dirty;
  state.pick = {
    accelerated: accelerated.outcome,
    brute,
    candidateGroups: accelerated.candidateGroups,
    stale,
  };

  const selectedId = accelerated.outcome.selected?.objectId ?? null;
  viewer.drawPick(ray, accelerated.outcome, selectedId, accelerated.outcome.candidateIds);
  viewer.setHighlight(null);
  redrawGroups(accelerated.outcome.visitedGroupIds);
  if (frame) frameRay(ray, selectedId);
  refreshPickPanel();
  refreshSpecials();
}

/** 把视角框到“射线起点 + 最近命中 + 至少中段”上，演示射线一按就能看清。 */
function frameRay(ray: RaySpec, selectedId: number | null): void {
  const points = [ray.origin.clone(), ray.origin.clone().addScaledVector(ray.direction, 26)];
  if (selectedId !== null) {
    const obj = state.objectsById.get(selectedId);
    if (obj) points.push(obj.position.clone());
  }
  viewer.framePoints(points);
}

function refreshPickPanel(): void {
  if (!state.pick || !state.currentRay) return;
  const { accelerated, brute, stale } = state.pick;
  const ray = state.currentRay;
  const total = state.scene.objects.length;

  const meta = el('ray-meta');
  meta.textContent = rayToDisplay(ray);
  meta.classList.remove('muted');

  setText('kpi-candidates', String(accelerated.candidateIds.length));
  setText(
    'kpi-candidates-foot',
    `占全部物件 ${((accelerated.candidateIds.length / total) * 100).toFixed(1)}%`,
  );
  setText('kpi-brute', String(brute.candidateIds.length));
  setText('kpi-hits', String(accelerated.hits.length));
  setText(
    'kpi-hits-foot',
    accelerated.hits.length > 0
      ? `最近的 t=${fmt(accelerated.hits[0].t, 3)}`
      : '没有物件与射线相交',
  );
  setText('kpi-groups', String(accelerated.visitedGroupIds.length));
  setText(
    'kpi-groups-foot',
    `共 ${state.bvh.leaves.length} 组 · 访问节点 ${accelerated.nodesTested}`,
  );

  const sel = accelerated.selected;
  if (sel) {
    const obj = state.objectsById.get(sel.objectId)!;
    setText('kpi-selected', `#${obj.id} ${obj.label}`);
    setText(
      'kpi-selected-foot',
      `t=${fmt(sel.t, 4)}${sel.inside ? ' · 起点在内部' : ''}` +
        (accelerated.tieIds.length > 1 ? ` · 并列 ${accelerated.tieIds.length} 件 ` : ''),
    );
    el('kpi-selected').classList.add('is-selected');
    el('kpi-hits').classList.add('is-hit');
  } else {
    setText('kpi-selected', '无命中');
    setText('kpi-selected-foot', '射线未与任何物件相交');
    el('kpi-selected').classList.remove('is-selected');
    el('kpi-hits').classList.remove('is-hit');
  }
  el('kpi-candidates').classList.add('is-candidate');

  const agreeStrict = sameOutcome(accelerated, brute);
  if (agreeStrict) {
    setStatus('agree-badge', 'good', '加速 = 逐件');
    let detail = '选中物件、命中列表、并列组一致';
    if (accelerated.tieIds.length > 1) detail += `；并列按 id 取 #${accelerated.tieIds[0]}`;
    if (stale) detail += '（注意：当前分组已过期）';
    setText('agree-detail', detail);
  } else {
    const acc = accelerated.selected;
    const bru = brute.selected;
    const samePick = comparePick(accelerated, brute);
    if (!stale) {
      setStatus('agree-badge', 'critical', '实现不一致');
      setText(
        'agree-detail',
        `加速 #${acc?.objectId ?? '—'} vs 逐件 #${bru?.objectId ?? '—'}；请报告该输入`,
      );
    } else if (!samePick) {
      setStatus('agree-badge', 'warning', '分组过期导致漏检');
      setText(
        'agree-detail',
        `加速 #${acc?.objectId ?? '—'} vs 逐件 #${bru?.objectId ?? '—'}；点「更新分组」后再比较`,
      );
    } else {
      // 选中一致但完整命中列表不同（多半是过期分组漏掉了更远的物件）
      setStatus('agree-badge', 'warning', '命中列表不同');
      setText(
        'agree-detail',
        `加速命中 ${accelerated.hits.length} 件，逐件命中 ${brute.hits.length} 件；分组已过期`,
      );
    }
  }

  renderCandidateTable();
  renderGroupList();
}

/** 按“访问到的组”拆分候选，直接回答“为什么一次点选会扫过这么多对象”。 */
function renderGroupList(): void {
  if (!state.pick) return;
  const { accelerated, candidateGroups } = state.pick;
  const hitIds = new Set(accelerated.hits.map((h) => h.objectId));

  interface Row {
    groupId: number;
    candidates: number;
    hits: number;
    members: number;
  }
  const rows = new Map<number, Row>();
  for (const id of accelerated.candidateIds) {
    const groupId = candidateGroups.get(id);
    if (groupId === undefined) continue;
    let row = rows.get(groupId);
    if (!row) {
      const leaf = state.bvh.leaves.find((l) => l.id === groupId);
      row = { groupId, candidates: 0, hits: 0, members: leaf?.objectIds.length ?? 0 };
      rows.set(groupId, row);
    }
    row.candidates++;
    if (hitIds.has(id)) row.hits++;
  }

  const ordered = [...rows.values()].sort(
    (a, b) => b.candidates - a.candidates || a.groupId - b.groupId,
  );
  const totalCandidates = accelerated.candidateIds.length || 1;
  const maxCandidates = Math.max(...ordered.map((r) => r.candidates), 1);
  const visited = accelerated.visitedGroupIds.length;

  el('group-note').textContent =
    visited === 0
      ? '本次射线没有命中任何叶组'
      : `共访问 ${visited} 组，合计 ${accelerated.candidateIds.length} 件候选，${accelerated.hits.length} 件命中` +
        (state.dirty ? '（分组已过期）' : '');

  el('group-list').innerHTML =
    ordered.length === 0
      ? '<div class="group-empty">没有候选：射线没有打到任何叶组。</div>'
      : ordered
          .slice(0, 8)
          .map((row) => {
            const share = ((row.candidates / totalCandidates) * 100).toFixed(0);
            const width = Math.max((row.candidates / maxCandidates) * 100, 3);
            return `<div class="group-row">
              <span class="group-id">组 ${row.groupId}</span>
              <span class="group-bar" title="该组 ${row.members} 件，其中 ${row.candidates} 件成为候选（占本次候选 ${share}%）"><i style="width:${width}%"></i></span>
              <span class="group-stat">${row.candidates} 候选<em>${row.hits ? ` · ${row.hits} 中` : ''}</em></span>
            </div>`;
          })
          .join('') +
        (ordered.length > 8
          ? `<div class="group-empty">另有 ${ordered.length - 8} 个组，每组贡献 1 件候选</div>`
          : '');
}

function renderCandidateTable(): void {
  if (!state.pick) return;
  const { accelerated, candidateGroups } = state.pick;
  const hitMap = new Map(accelerated.hits.map((h) => [h.objectId, h]));
  const selId = accelerated.selected?.objectId ?? null;
  const tieSet = new Set(accelerated.tieIds);

  const rows = accelerated.candidateIds
    .map((id) => ({ id, hit: hitMap.get(id) ?? null }))
    .sort((a, b) => {
      if (a.hit && b.hit) return a.hit.t - b.hit.t || a.id - b.id;
      if (a.hit) return -1;
      if (b.hit) return 1;
      return a.id - b.id;
    });

  const limit = 120;
  const shown = rows.slice(0, limit);
  const tbody = el('candidate-table').querySelector('tbody')!;
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">没有候选</td></tr>';
  } else {
    tbody.innerHTML = shown
      .map(({ id, hit }) => {
        const obj = state.objectsById.get(id)!;
        const isSel = id === selId;
        const isHit = hit !== null;
        const cls = isSel ? 'row-selected' : isHit ? 'row-hit' : '';
        const tag = isSel
          ? '<span class="tag tag-selected">选中</span>'
          : isHit
            ? '<span class="tag tag-hit">命中</span>'
            : '<span class="tag tag-candidate">仅候选</span>';
        const tText = hit
          ? `${fmt(hit.t, 4)}${hit.inside ? ' ⏺' : ''}${tieSet.has(id) && accelerated.tieIds.length > 1 ? ' =' : ''}`
          : '—';
        return `<tr class="${cls}">
          <td>#${obj.id} ${escapeHtml(obj.label)}</td>
          <td class="num">${candidateGroups.get(id) ?? '—'}</td>
          <td class="num">${tText}</td>
          <td>${tag}</td>
        </tr>`;
      })
      .join('');
  }

  const note =
    rows.length > limit
      ? `候选 ${rows.length} 件，命中 ${accelerated.hits.length} 件；仅列出前 ${limit} 件`
      : `候选 ${rows.length} 件，命中 ${accelerated.hits.length} 件` +
        (accelerated.tieIds.length > 1 ? `，并列 ${accelerated.tieIds.length} 件（=）` : '') +
        (accelerated.hits.some((h) => h.inside) ? '；⏺ 表示起点在物件内部' : '');
  setText('candidate-note', note);
}

// ---------------------------------------------------------------------------
// 射线按钮
// ---------------------------------------------------------------------------

function renderRayButtons(): void {
  const host = el('ray-buttons');
  host.innerHTML = '';
  const fixed = demoRays();
  for (const ray of fixed) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = ray.label;
    btn.title = '使用固定演示射线';
    btn.addEventListener('click', () => {
      if (state.mode !== 'inspect') setMode('inspect');
      runPick(ray, true);
    });
    host.appendChild(btn);
  }
  const hint = document.createElement('span');
  hint.className = 'chip chip-static';
  hint.textContent = '或在 3D 视口单击';
  hint.title = '在 3D 视口中单击即可从相机发射一条射线';
  host.appendChild(hint);
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

function selectForEdit(id: number | null): void {
  state.editId = id;
  viewer.setTransformTarget(id);
  viewer.setHighlight(id);
  const resetBtn = el<HTMLButtonElement>('reset-object');
  resetBtn.disabled = id === null;
  if (id === null) {
    setStatus('edit-status', 'neutral', '未选中');
    el('edit-meta').innerHTML = '<span class="muted">尚未选择编辑对象。</span>';
    return;
  }
  setStatus('edit-status', 'good', `#${id}`);
  refreshEditMeta();
}

function refreshEditMeta(): void {
  const id = state.editId;
  if (id === null) return;
  const obj = state.objectsById.get(id)!;
  const p = obj.position;
  const s = obj.size;
  const rot = eulerDegrees(obj);
  el('edit-meta').innerHTML = `
    <div>#${obj.id} ${escapeHtml(obj.label)} · ${obj.kind === 'box' ? '盒体' : '球体'}</div>
    <div>pos (${fmt(p.x, 2)}, ${fmt(p.y, 2)}, ${fmt(p.z, 2)})</div>
    <div>size (${fmt(s.x, 2)}, ${fmt(s.y, 2)}, ${fmt(s.z, 2)})</div>
    <div>rot° (${fmt(rot.x, 1)}, ${fmt(rot.y, 1)}, ${fmt(rot.z, 1)})</div>
    <div style="color: var(--text-muted)">AABB ${aabbText(obj)}</div>`;
}

function eulerDegrees(obj: SceneObject): { x: number; y: number; z: number } {
  const e = new Euler().setFromQuaternion(obj.quaternion, 'XYZ');
  const toDeg = 180 / Math.PI;
  return { x: e.x * toDeg, y: e.y * toDeg, z: e.z * toDeg };
}

function aabbText(obj: SceneObject): string {
  const box = objectAabb(obj);
  const size = {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  };
  return `${fmt(size.x, 2)} × ${fmt(size.y, 2)} × ${fmt(size.z, 2)}`;
}

/**
 * 复位后当前位置可能与旧分组不一致（例如分组是在变换之后重建的），
 * 因此直接按当前物件重建一次，保证“复位”之后分组确定有效。
 */
function rebuildAfterReset(): void {
  rebuildBvh();
  state.dirty = false;
  refreshGroupStats();
  updateDirtyBanner();
  redrawGroups(state.pick?.accelerated.visitedGroupIds ?? []);
  if (state.currentRay) runPick(state.currentRay);
  refreshSpecials();
  if (state.batch) {
    setStatus('batch-badge', 'neutral', '分组已更新');
    setText('batch-detail', '请重新运行核查以采用新分组。');
  }
}

function resetObject(): void {
  const id = state.editId;
  if (id === null) return;
  const obj = state.objectsById.get(id)!;
  obj.position.copy(obj.initial.position);
  obj.quaternion.copy(obj.initial.quaternion);
  obj.size.copy(obj.initial.size);
  viewer.syncObjectsFromCore();
  refreshEditMeta();
  rebuildAfterReset();
}

function resetAll(): void {
  resetObjects(state.scene.objects);
  viewer.syncObjectsFromCore();
  refreshEditMeta();
  rebuildAfterReset();
}

/**
 * 演示“分组过期会漏检”：把一件当前不在候选里的物件搬到射线上，
 * 不重建分组 -> 加速路径仍按旧 AABB 剪枝，逐件路径则能看到它。
 */
function demoStaleMiss(): void {
  const ray = state.currentRay;
  if (!ray) {
    setStatus('batch-badge', 'neutral', '先发射一条射线');
    return;
  }
  const candidateIds = new Set(state.pick?.accelerated.candidateIds ?? []);
  const victim = state.scene.objects.find(
    (o) => o.id >= 6 && !candidateIds.has(o.id),
  );
  if (!victim) return;

  if (state.mode !== 'inspect') setMode('inspect');

  // 放到射线起点前方 12 个单位处，正好挡住射线。
  victim.position.copy(ray.origin).addScaledVector(ray.direction, 12);
  victim.size.set(3.2, 3.2, 3.2);
  viewer.syncObjectsFromCore();

  selectForEdit(victim.id);
  refreshEditMeta();
  afterEditChange();
}

function afterEditChange(): void {
  if (!state.dirty) {
    state.dirty = true;
    refreshGroupStats();
  }
  updateDirtyBanner();
  refreshSpecials();
  if (state.currentRay) runPick(state.currentRay);
  redrawGroups(state.pick?.accelerated.visitedGroupIds ?? []);
  if (state.batch) {
    setStatus('batch-badge', 'warning', '需重跑');
    setText('batch-detail', '物件已变换，下方结果为变换前的快照。');
  }
}

// ---------------------------------------------------------------------------
// 固定演示项检查
// ---------------------------------------------------------------------------

interface SpecialItem {
  title: string;
  description: string;
  ok: boolean;
  detail: string;
}

function computeSpecialItems(scene: GeneratedScene): SpecialItem[] {
  const byId = new Map(scene.objects.map((o) => [o.id, o]));
  const rayByTag = new Map(scene.rays.map((r) => [r.tag, r]));
  const run = (tag: string): PickOutcome => {
    const ray = rayByTag.get(tag)!;
    return pickBrute(scene.objects, ray.origin, ray.direction);
  };

  const items: SpecialItem[] = [];

  const nestedRay = rayByTag.get('nested')!;
  const nested = run('nested');
  const nestedIds = nested.hits.map((h) => h.objectId);
  items.push({
    title: '相交嵌套',
    description: `外壳 #${scene.specials.nestedOuterId} 与内球 #${scene.specials.nestedInnerId} 中心重合，射线同时穿过两者。`,
    ok:
      nestedIds[0] === scene.specials.nestedOuterId &&
      nestedIds.includes(scene.specials.nestedInnerId),
    detail:
      nested.hits.length > 0
        ? `命中顺序 ${nestedIds.map((id) => `#${id}`).join(' → ')}，选中 #${nested.selected?.objectId}。`
        : '当前没有命中（物件可能已被移走）。',
  });
  void nestedRay;

  const inside = run('inside');
  const container = byId.get(scene.specials.insideId)!;
  items.push({
    title: '射线从物体内部发出',
    description: `起点位于容器 #${container.id} 内，该物件必须优先于外部物件。`,
    ok:
      inside.selected?.objectId === container.id &&
      inside.selected.t === 0 &&
      inside.selected.inside,
    detail:
      inside.selected?.objectId === container.id
        ? `选中 #${inside.selected.objectId}，t=0，inside=${inside.selected.inside}。`
        : `选中 #${inside.selected?.objectId ?? '—'}，不符合内部起点规则。`,
  });

  const tie = run('tie');
  const [a, b] = scene.specials.tieIds;
  items.push({
    title: '命中并列',
    description: `两个等距球 #${a} / #${b} 同时命中，距离差 ≤ 1e-4 时按 id 小者胜出。`,
    ok:
      tie.selected?.objectId === Math.min(a, b) &&
      tie.tieIds.length === 2 &&
      tie.tieIds.includes(a) &&
      tie.tieIds.includes(b),
    detail:
      tie.tieIds.length > 1
        ? `并列 #${tie.tieIds.join(' / #')}，t=${fmt(tie.tieT ?? 0, 5)}，选中 #${tie.selected?.objectId}。`
        : `当前未形成并列命中（选中 #${tie.selected?.objectId ?? '—'}）。`,
  });

  const aabbRay = rayByTag.get('aabb')!;
  const aabbPick = run('aabb');
  const fpId = scene.specials.aabbFalsePositiveId;
  const aabbHits = rayHitsBox(aabbRay.origin, aabbRay.direction, objectAabb(byId.get(fpId)!));
  items.push({
    title: 'AABB 误报',
    description: `球体 #${fpId} 的包围盒被射线擦过，但球面本身不在射线上（起点贴着 AABB 角落）。`,
    ok: aabbHits && aabbPick.hits.length === 0,
    detail: `包围盒命中 ${aabbHits ? 1 : 0} / 1，精确求交命中 ${aabbPick.hits.length} 件。`,
  });

  return items;
}

function refreshSpecials(): void {
  const items = computeSpecialItems(state.scene);
  const list = el('spec-list');
  list.innerHTML = items
    .map(
      (item) => `<li>
        <span class="tag ${item.ok ? 'tag-selected' : 'tag-hit'}">${item.ok ? '符合' : '偏离'}</span>
        <div><strong>${escapeHtml(item.title)}</strong><br /><span class="muted">${escapeHtml(
          item.description,
        )}</span><br />${escapeHtml(item.detail)}</div>
      </li>`,
    )
    .join('');
  const okCount = items.filter((i) => i.ok).length;
  if (okCount === items.length) {
    setStatus('specials-badge', 'good', `${okCount} / ${items.length} 符合规则`);
    setText('specials-detail', '按当前物件位置实时检查');
  } else {
    setStatus('specials-badge', 'warning', `${okCount} / ${items.length} 符合规则`);
    setText('specials-detail', '物件被编辑后，固定射线可能不再命中预期目标');
  }
}

// ---------------------------------------------------------------------------
// 批量核查
// ---------------------------------------------------------------------------

function clearBatchPanel(): void {
  state.batch = null;
  setStatus('batch-badge', 'neutral', '尚未运行');
  setText('batch-detail', '—');
  el('batch-chart').innerHTML = '';
  el('batch-chart-block').classList.add('hidden');
  el('batch-legend').classList.add('hidden');
  el('batch-table').querySelector('tbody')!.innerHTML =
    '<tr><td colspan="8" class="muted">点击「运行核查」</td></tr>';
}

function runBatch(): void {
  setStatus('batch-badge', 'neutral', '运行中…');
  setText('batch-detail', '正在对每个分组上限重建分组，并逐条射线对照。');
  el<HTMLButtonElement>('run-batch').disabled = true;

  // 让浏览器先画出“运行中”
  requestAnimationFrame(() => {
    try {
      const reports: CapBatchReport[] = [];
      const objects = state.scene.objects;
      const rays = state.rayBatch;

      for (const capacity of CAPACITY_PRESETS) {
        const bvh = buildBvh(objects, capacity);
        let sumCand = 0;
        let maxCand = 0;
        let sumGroups = 0;
        let maxGroups = 0;
        let sumNodes = 0;
        let accelMs = 0;
        let bruteMs = 0;
        const mismatches: CapBatchReport['mismatches'] = [];

        for (const ray of rays) {
          const accel = pickWithBvh(bvh, state.objectsById, ray.origin, ray.direction).outcome;
          const brute = pickBrute(objects, ray.origin, ray.direction);
          accelMs += accel.elapsedMs;
          bruteMs += brute.elapsedMs;
          sumCand += accel.candidateIds.length;
          maxCand = Math.max(maxCand, accel.candidateIds.length);
          sumGroups += accel.visitedGroupIds.length;
          maxGroups = Math.max(maxGroups, accel.visitedGroupIds.length);
          sumNodes += accel.nodesTested;

          if (!comparePick(accel, brute) || !sameOutcome(accel, brute)) {
            mismatches.push({
              ray: ray.label,
              accelerated: accel.selected?.objectId ?? null,
              brute: brute.selected?.objectId ?? null,
            });
          }
        }

        reports.push({
          capacity,
          groupCount: bvh.leaves.length,
          maxDepth: bvh.maxDepth,
          rayCount: rays.length,
          mismatches,
          avgCandidates: sumCand / rays.length,
          maxCandidates: maxCand,
          avgVisitedGroups: sumGroups / rays.length,
          maxVisitedGroups: maxGroups,
          avgNodesTested: sumNodes / rays.length,
          accelMs,
          bruteMs,
        });
      }

      state.batch = reports;
      renderBatch(reports);
      if (state.dirty) {
        setStatus('batch-badge', 'warning', '一致（分组基于当前物件重建）');
        setText(
          'batch-detail',
          `已按当前物件位置重建分组；但页面上的分组边界仍为旧值，请点「更新分组」。`,
        );
      }
    } finally {
      el<HTMLButtonElement>('run-batch').disabled = false;
    }
  });
}

function renderBatch(reports: CapBatchReport[]): void {
  const total = state.scene.objects.length;
  const totalMismatch = reports.reduce((s, r) => s + r.mismatches.length, 0);
  const rayCount = reports[0]?.rayCount ?? 0;

  if (totalMismatch === 0) {
    setStatus('batch-badge', 'good', '全部一致');
    setText(
      'batch-detail',
      `${reports.length} 种分组上限 × ${rayCount} 条射线，选中物件 / 命中列表 / 并列组全部一致。`,
    );
  } else {
    setStatus('batch-badge', 'critical', `${totalMismatch} 处不一致`);
    const first = reports.flatMap((r) => r.mismatches.map((m) => ({ ...m, cap: r.capacity })))[0];
    setText(
      'batch-detail',
      first
        ? `例如上限 ${first.cap}：${first.ray}，加速 #${first.accelerated ?? '—'} vs 逐件 #${first.brute ?? '—'}`
        : '—',
    );
  }

  // 条形图：平均候选数。以本批最大值为满量程，便于比较不同上限。
  el('batch-chart-block').classList.remove('hidden');
  el('batch-legend').classList.remove('hidden');
  setText('batch-chart-title', '平均候选数（每根射线进入精确求交的件数）');
  const maxAvg = Math.max(...reports.map((r) => r.avgCandidates), 1);
  const scaleMax = maxAvg;
  setText('batch-scale', `横轴 0 — ${fmt(maxAvg, 1)} 件（本批最大值）· 物件总数 ${total}`);
  el('batch-chart').innerHTML = reports
    .map((r) => {
      const width = Math.max((r.avgCandidates / scaleMax) * 100, 0.4);
      const share = ((r.avgCandidates / total) * 100).toFixed(1);
      const active = r.capacity === state.capacity;
      return `<div class="bar-row${active ? ' is-active' : ''}" title="上限 ${r.capacity}：平均候选 ${fmt(
        r.avgCandidates,
        1,
      )} / ${total}（${share}%），最大 ${r.maxCandidates}">
        <span class="bar-label">上限 ${r.capacity}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
        <span class="bar-value">${fmt(r.avgCandidates, 1)}</span>
      </div>`;
    })
    .join('');

  el('batch-table').querySelector('tbody')!.innerHTML = reports
    .map(
      (r) => `<tr class="${r.capacity === state.capacity ? 'row-selected' : ''}">
        <td class="num">${r.capacity}</td>
        <td class="num">${r.groupCount}</td>
        <td class="num">${r.maxDepth}</td>
        <td class="num">${fmt(r.avgCandidates, 1)}</td>
        <td class="num">${r.maxCandidates}</td>
        <td class="num">${fmt(r.avgVisitedGroups, 1)}</td>
        <td class="num">${fmt(r.accelMs, 1)} / ${fmt(r.bruteMs, 1)}</td>
        <td>${
          r.mismatches.length === 0
            ? '<span class="tag tag-selected">一致</span>'
            : `<span class="tag tag-hit">${r.mismatches.length} 处</span>`
        }</td>
      </tr>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// 模式与事件绑定
// ---------------------------------------------------------------------------

function setMode(mode: Mode): void {
  state.mode = mode;
  viewer.setEditEnabled(mode === 'edit');
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  const hint = el('mode-hint');
  hint.textContent =
    mode === 'inspect'
      ? '点选核查模式：单击场景发射射线'
      : '编辑物件模式：单击选择物件，拖动手柄旋转/缩放';
  if (mode === 'inspect') {
    viewer.setTransformTarget(null);
    viewer.setHighlight(state.pick?.accelerated.selected?.objectId ?? null);
    if (state.pick && state.currentRay) {
      viewer.drawPick(
        state.currentRay,
        state.pick.accelerated,
        state.pick.accelerated.selected?.objectId ?? null,
        state.pick.accelerated.candidateIds,
      );
    }
    redrawGroups(state.pick?.accelerated.visitedGroupIds ?? []);
  } else {
    // 编辑模式下去掉点选着色，避免和编辑描边混在一起。
    viewer.clearPick();
    viewer.setHighlight(state.editId);
    redrawGroups();
    setStatus('edit-status', state.editId === null ? 'neutral' : 'good', state.editId === null ? '未选中' : `#${state.editId}`);
  }
}

function bindUi(): void {
  el<HTMLButtonElement>('regenerate').addEventListener('click', () => {
    const input = el<HTMLInputElement>('seed-input');
    const seed = Math.trunc(Number(input.value));
    if (!Number.isFinite(seed)) {
      input.value = String(DEFAULT_SEED);
      loadScene(DEFAULT_SEED);
      return;
    }
    loadScene(seed >>> 0);
  });

  el('reset-view').addEventListener('click', () => viewer.resetCamera());
  el('update-groups').addEventListener('click', updateGroupsNow);
  el('dirty-rebuild').addEventListener('click', updateGroupsNow);
  el('show-groups').addEventListener('change', () =>
    redrawGroups(state.pick?.accelerated.visitedGroupIds ?? []),
  );
  el('run-batch').addEventListener('click', runBatch);
  el('reset-object').addEventListener('click', resetObject);
  el('reset-all').addEventListener('click', resetAll);
  el('demo-stale').addEventListener('click', demoStaleMiss);

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode as Mode));
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-gizmo]')) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.gizmo as GizmoMode;
      viewer.setGizmoMode(mode);
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-gizmo]')) {
        b.classList.toggle('active', b === btn);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

bindUi();
loadScene(DEFAULT_SEED);

// 方便在控制台里检查内部状态
Object.defineProperty(window, '__probe', {
  value: () => state,
  configurable: true,
});
