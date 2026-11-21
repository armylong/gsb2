import { genTerrain, cellAt, Terrain, TerrainStyle, Zone, ZONE_LABEL } from './terrain';
import { PRESETS, VegType } from './vegetation';
import { generate, inRegion, Attempt, GapReport, Placement, Region } from './generator';
import { serialize, deserialize } from './state';

const W = 48;
const H = 32;
const CELL = 18;

const ZONE_COLORS: Record<Zone, string> = {
  water: '#2f5d8a',
  wet: '#3f6b46',
  slope: '#7a6a4a',
  clearing: '#8a8a4f',
  plain: '#4f7a44',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;

interface State {
  seed: string;
  terrainStyle: TerrainStyle;
  types: VegType[];
  terrain: Terrain;
  placements: Placement[];
  decisions: Map<string, Attempt[]>;
  report: GapReport;
}

let state: State;
let mode: 'inspect' | 'pin' | 'region' = 'inspect';
let dragStart: { x: number; y: number } | null = null;
let dragRect: Region | null = null;
let hover: { x: number; y: number } | null = null;

function currentMode(): typeof mode {
  const el = document.querySelector<HTMLInputElement>('input[name=mode]:checked');
  return (el?.value as typeof mode) ?? 'inspect';
}

function readInputs(): { seed: string; terrainStyle: TerrainStyle } {
  return {
    seed: $<HTMLInputElement>('seed').value || 'demo-42',
    terrainStyle: $<HTMLSelectElement>('terrainStyle').value as TerrainStyle,
  };
}

function syncSpacingInputs(): void {
  for (const t of state.types) {
    const el = $<HTMLInputElement>(`sp-${t.id}`);
    if (el) el.value = String(t.minSpacing);
  }
}

function applySpacingInputs(): void {
  for (const t of state.types) {
    const el = $<HTMLInputElement>(`sp-${t.id}`);
    if (el) t.minSpacing = Math.max(1, Number(el.value) || t.minSpacing);
  }
}

function regenerate(region?: Region): void {
  applySpacingInputs();
  const { seed, terrainStyle } = readInputs();
  const terrainChanged = seed !== state.seed || terrainStyle !== state.terrainStyle;
  state.seed = seed;
  state.terrainStyle = terrainStyle;
  if (terrainChanged || !state.terrain) {
    state.terrain = genTerrain(seed, terrainStyle, W, H);
    state.placements = state.placements.filter((p) => p.pinned); // 换地形只保留固定点
  }
  const r = region ?? { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  const keep = state.placements.filter((p) => p.pinned || !inRegion(p.x, p.y, r));
  const result = generate(state.terrain, state.types, seed, { region: r, keep });
  state.placements = result.placements;
  // 合并决策记录：区域内用新结果，区域外保留旧记录
  if (region) {
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) state.decisions.delete(`${x},${y}`);
    for (const [k, v] of result.decisions) state.decisions.set(k, v);
  } else {
    state.decisions = result.decisions;
  }
  state.report = result.report;
  render();
  renderReport();
}

function applyPreset(id: string): void {
  const preset = PRESETS[id];
  if (!preset) return;
  state.types = structuredClone(preset.types);
  state.placements = [];
  state.decisions = new Map();
  $<HTMLSelectElement>('terrainStyle').value = preset.terrainStyle;
  syncSpacingInputs();
  regenerate();
}

function render(): void {
  const { terrain, placements } = state;
  for (const c of terrain.cells) {
    ctx.fillStyle = ZONE_COLORS[c.zone];
    ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
    // 高度明暗
    const shade = Math.max(-0.25, Math.min(0.25, (c.height - 0.5) * 0.3));
    if (shade !== 0 && c.zone !== 'water') {
      ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
      ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
    }
  }
  for (const p of placements) {
    const t = state.types.find((t) => t.id === p.type);
    const cx = p.x * CELL + CELL / 2;
    const cy = p.y * CELL + CELL / 2;
    const radius = p.type === 'tree' ? 7 : p.type === 'shrub' ? 5 : p.type === 'reed' ? 4 : 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = t?.color ?? '#fff';
    ctx.fill();
    if (p.pinned) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
  if (hover) {
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 1;
    ctx.strokeRect(hover.x * CELL + 0.5, hover.y * CELL + 0.5, CELL - 1, CELL - 1);
  }
  if (dragRect) {
    ctx.fillStyle = 'rgba(255,80,80,0.25)';
    ctx.fillRect(
      dragRect.x0 * CELL,
      dragRect.y0 * CELL,
      (dragRect.x1 - dragRect.x0 + 1) * CELL,
      (dragRect.y1 - dragRect.y0 + 1) * CELL,
    );
  }
}

function renderReport(): void {
  const r = state.report;
  const lines = [
    `需求格子：${r.demand}，放下：${r.placed}，缺口：${r.gaps}`,
    r.gaps > 0 ? '' : '全部需求均已放下。',
  ];
  if (r.topConstraints.length > 0) {
    lines.push('最常见限制：');
    for (const c of r.topConstraints.slice(0, 5)) lines.push(`  ${c.reason} × ${c.count}`);
  }
  if (r.gapCells.length > 0) {
    lines.push(`缺口示例（前 8 个）：`);
    for (const g of r.gapCells.slice(0, 8)) lines.push(`  (${g.x},${g.y}) ${g.type}`);
  }
  $('report').textContent = lines.join('\n');
}

function inspectCell(x: number, y: number): void {
  const c = cellAt(state.terrain, x, y);
  const lines = [
    `格子 (${x}, ${y})  分区：${ZONE_LABEL[c.zone]}`,
    `高度 ${c.height.toFixed(2)}  湿度 ${c.moisture.toFixed(2)}  坡度 ${c.slope.toFixed(2)}`,
    '',
  ];
  const attempts = state.decisions.get(`${x},${y}`);
  if (!attempts || attempts.length === 0) {
    lines.push('（该区域尚未重算，无决策记录）');
  } else {
    for (const a of attempts) {
      const t = state.types.find((t) => t.id === a.type);
      lines.push(`${a.result === 'accepted' ? '✔' : '✘'} ${t?.name ?? a.type}：${a.reason}`);
    }
  }
  const p = state.placements.find((p) => p.x === x && p.y === y);
  if (p?.pinned) lines.push('', '※ 手工固定位置，局部重算时保留');
  $('inspect').textContent = lines.join('\n');
}

function cellFromEvent(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * W);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * H);
  return { x: Math.max(0, Math.min(W - 1, x)), y: Math.max(0, Math.min(H - 1, y)) };
}

canvas.addEventListener('mousedown', (e) => {
  mode = currentMode();
  const { x, y } = cellFromEvent(e);
  if (mode === 'inspect') {
    inspectCell(x, y);
  } else if (mode === 'pin') {
    const existing = state.placements.findIndex((p) => p.x === x && p.y === y);
    if (existing >= 0 && state.placements[existing].pinned) {
      state.placements.splice(existing, 1); // 再点一次取消固定
    } else {
      if (existing >= 0) state.placements.splice(existing, 1);
      state.placements.push({ x, y, type: $<HTMLSelectElement>('pinType').value, pinned: true });
    }
    regenerate(dragRect ?? undefined);
    inspectCell(x, y);
  } else if (mode === 'region') {
    dragStart = { x, y };
    dragRect = { x0: x, y0: y, x1: x, y1: y };
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = cellFromEvent(e);
  hover = { x, y };
  if (dragStart) {
    dragRect = {
      x0: Math.min(dragStart.x, x),
      y0: Math.min(dragStart.y, y),
      x1: Math.max(dragStart.x, x),
      y1: Math.max(dragStart.y, y),
    };
  }
  render();
});

canvas.addEventListener('mouseup', () => {
  if (dragStart && dragRect) {
    regenerate(dragRect);
  }
  dragStart = null;
  dragRect = null;
  render();
});

$('regen').addEventListener('click', () => regenerate());
$('applyPreset').addEventListener('click', () => applyPreset($<HTMLSelectElement>('preset').value));
$('save').addEventListener('click', () => {
  const json = serialize(state.seed, state.terrainStyle, state.types, state.placements);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'veg-map.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('load').addEventListener('click', () => $<HTMLInputElement>('file').click());
$('file').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('file').files?.[0];
  if (!file) return;
  try {
    const data = deserialize(await file.text());
    state.types = data.types;
    state.placements = data.placements;
    $<HTMLInputElement>('seed').value = data.seed;
    $<HTMLSelectElement>('terrainStyle').value = data.terrainStyle;
    state.seed = data.seed;
    state.terrainStyle = data.terrainStyle;
    state.terrain = genTerrain(data.seed, data.terrainStyle, W, H);
    // 重建决策记录用于格子检查；放置结果以存档为准
    const pins = data.placements.filter((p) => p.pinned);
    const fresh = generate(state.terrain, state.types, data.seed, { keep: pins });
    state.decisions = fresh.decisions;
    state.report = fresh.report;
    syncSpacingInputs();
    render();
    renderReport();
  } catch (err) {
    alert(`加载失败：${err}`);
  }
});

// 初始化
const init = readInputs();
state = {
  seed: init.seed,
  terrainStyle: init.terrainStyle,
  types: structuredClone(PRESETS.default.types),
  terrain: genTerrain(init.seed, init.terrainStyle, W, H),
  placements: [],
  decisions: new Map(),
  report: { demand: 0, placed: 0, gaps: 0, gapCells: [], topConstraints: [] },
};
syncSpacingInputs();
regenerate();
