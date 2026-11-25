import type { BatchPlan } from '../core/batching';
import { batchSpriteLabels } from '../core/batching';
import type { BufferDiff, PixelSample } from '../core/compare';
import type { Scene, Sprite } from '../core/types';
import type { TextureDef } from '../render/textures';

export interface PanelCallbacks {
  onHoverBatch: (batch: number | null) => void;
  onSelectBatch: (batch: number) => void;
  onSelectSprite: (spriteIndex: number) => void;
  onFocusInterruption: (before: number, after: number) => void;
  onSetProbeLayer: (spriteIndex: number, layer: number) => void;
  onSetProbeBlend: (spriteIndex: number, blend: 'alpha' | 'additive') => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

export interface StatsData {
  plan: BatchPlan;
  stats: {
    refSpriteCalls: number;
    batchSpriteCalls: number;
    refBackdropCalls: number;
    batchBackdropCalls: number;
  };
  scene: Scene;
  offScreenProbes: number;
  /** 画布重绘一次的总 draw call（含背景与全屏合成）。 */
  frameDrawCalls: number;
}

export function renderStats(container: HTMLElement, data: StatsData): void {
  const { plan, stats } = data;
  container.replaceChildren();
  const add = (
    key: string,
    value: string,
    unit?: string,
    tone?: 'accent' | 'warn',
    wide = false,
  ): void => {
    const box = el('div', `stat${wide ? ' wide' : ''}${tone ? ` ${tone}` : ''}`);
    box.append(el('div', 'k', key));
    const v = el('div', 'v', value);
    if (unit) v.append(el('small', '', unit));
    box.append(v);
    container.append(box);
  };

  add('入镜精灵', fmt(plan.counts.visible), '个', 'accent');
  add('合批实际绘制', fmt(stats.batchSpriteCalls), '次');
  add('参考实际绘制', fmt(stats.refSpriteCalls), '次');
  add('剔除', fmt(plan.counts.culled), '个');
  add('混合切换切段', fmt(plan.counts.blendBreaks), '处', plan.counts.blendBreaks > 0 ? 'warn' : undefined);
  add('层切换切段', fmt(plan.counts.layerBreaks), '处');
  add('被夹断的批次对', fmt(plan.counts.interruptedPairs), '对', plan.counts.interruptedPairs > 0 ? 'warn' : undefined);
  add('其中探针制造', fmt(plan.counts.probeInterruptedPairs), '对', plan.counts.probeInterruptedPairs > 0 ? 'warn' : undefined);
  add(
    '平均每批实例',
    stats.batchSpriteCalls > 0 ? (stats.refSpriteCalls / stats.batchSpriteCalls).toFixed(2) : '—',
    '个',
  );
  add('本帧总 draw call', fmt(data.frameDrawCalls), '次', undefined, true);
  add(
    '批次构成',
    `α ${fmt(plan.counts.batchesByBlend.alpha)} 批 · ＋ ${fmt(plan.counts.batchesByBlend.additive)} 批`,
    undefined,
    undefined,
    true,
  );
}

export function renderOffScreenNote(container: HTMLElement, data: StatsData): void {
  const { plan, scene } = data;
  const probes = scene.sprites.filter((s) => s.draggable);
  const out = probes.filter((p) => {
    const idx = scene.sprites.indexOf(p);
    return !plan.visible.includes(idx);
  });
  if (out.length === 0) {
    container.textContent = '';
    return;
  }
  container.textContent = `探针 ${out.map((p) => p.label).join('、')} 已拖出画面，不计入入镜与批次统计。`;
}

export function renderRibbon(
  container: HTMLElement,
  plan: BatchPlan,
  _sprites: readonly Sprite[],
  selectedBatch: number | null,
  hoverBatch: number | null,
  focusPair: readonly [number, number] | null,
  cb: PanelCallbacks,
): void {
  container.replaceChildren();
  if (plan.batches.length === 0) {
    container.append(el('div', 'muted small', '当前视野内没有精灵'));
    return;
  }
  // 探针夹断：用户亲手把另一种混合设置的精灵塞进同层造成的切段。
  const probeInterrupted = new Set<number>();
  for (const it of plan.interruptions) {
    if (!it.viaProbe) continue;
    probeInterrupted.add(it.before);
    probeInterrupted.add(it.after);
    for (const b of it.between) probeInterrupted.add(b);
  }
  const total = plan.paintOrder.length;
  const batchRow = el('div', 'ribbon-row');
  for (const batch of plan.batches) {
    const seg = el('div', 'ribbon-seg');
    seg.style.width = `${Math.max(0.35, (batch.count / total) * 100)}%`;
    // 底色按混合设置：蓝=普通透明，橙=叠加发光；亮度微调区分相邻批次。
    const hue = batch.blend === 'alpha' ? 199 : 32;
    const light = 48 + ((batch.index * 5) % 3) * 7;
    seg.style.background = `hsl(${hue} 72% ${light}%)`;
    if (batch.blend === 'additive') {
      seg.style.backgroundImage =
        'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 5px)';
    }
    if (probeInterrupted.has(batch.index)) seg.classList.add('interrupted');
    if (batch.index === selectedBatch) seg.classList.add('selected');
    if (batch.index === hoverBatch) seg.classList.add('focused');
    if (focusPair && (focusPair[0] === batch.index || focusPair[1] === batch.index)) seg.classList.add('focused');
    seg.title = `批次 #${batch.index} · 第 ${batch.layer + 1} 层 · ${batch.blend === 'alpha' ? '普通透明' : '叠加发光'} · ${batch.count} 个 · 位次 ${batch.first + 1}..${batch.first + batch.count}`;
    seg.addEventListener('pointerenter', () => cb.onHoverBatch(batch.index));
    seg.addEventListener('pointerleave', () => cb.onHoverBatch(null));
    seg.addEventListener('click', () => cb.onSelectBatch(batch.index));
    batchRow.append(seg);
  }
  container.append(batchRow);

  // 层带：层边界是整段切开的真实位置；同层内的混合切换靠上层颜色体现。
  const layerRow = el('div', 'ribbon-layers');
  for (const span of plan.layerSpans) {
    const band = el('div', 'ribbon-layer');
    band.style.width = `${(span.count / total) * 100}%`;
    band.style.background = `hsl(220 22% ${28 + span.layer * 4}%)`;
    band.textContent = span.count / total > 0.045 ? `L${span.layer + 1}` : '';
    band.title = `第 ${span.layer + 1} 层 · ${span.count} 个精灵 · ${span.batches.length} 个批次`;
    layerRow.append(band);
  }
  container.append(layerRow);
}

export function renderBatchList(
  container: HTMLElement,
  plan: BatchPlan,
  sprites: readonly Sprite[],
  selectedBatch: number | null,
  cb: PanelCallbacks,
): void {
  container.replaceChildren();
  if (plan.batches.length === 0) {
    container.append(el('div', 'muted small', '无批次'));
    return;
  }
  // 密集场景批次可达数百条；列表太长时截断，完整批次带仍在上方。
  const MAX_ROWS = 160;
  for (const batch of plan.batches.slice(0, MAX_ROWS)) {
    const row = el('div', 'batch-row');
    if (batch.index === selectedBatch) row.classList.add('selected');
    row.append(el('div', 'idx', `#${batch.index}`));

    const meta = el('div', 'meta');
    const labels = batchSpriteLabels(plan, sprites, batch, 5);
    const labelText = labels.join(' ') + (batch.count > labels.length ? ` +${batch.count - labels.length}` : '');
    meta.append(el('b', '', `${batch.count} 个 · ${labelText}`));
    const cutText =
      batch.cut === 'blend-switch'
        ? '← 混合切换'
        : batch.cut === 'layer-switch'
          ? '← 层切换'
          : '场景起点';
    const extra =
      batch.cut === 'scene-start'
        ? `第 ${batch.layer + 1} 层 · ${cutText}`
        : `第 ${batch.layer + 1} 层 · ${cutText}（与上批不同）`;
    meta.append(el('span', '', extra));
    row.append(meta);

    const right = el('div');
    right.style.display = 'flex';
    right.style.flexDirection = 'column';
    right.style.alignItems = 'flex-end';
    right.style.gap = '2px';
    const badge = el('span', `badge ${batch.blend === 'alpha' ? 'a' : 'b'}`, batch.blend === 'alpha' ? '普通透明' : '叠加发光');
    right.append(badge);
    if (plan.interruptedBatch[batch.index]) {
      const probeHit = plan.interruptions.some(
        (it) => it.viaProbe && (it.before === batch.index || it.after === batch.index),
      );
      const badge2 = el('span', 'badge interrupt', probeHit ? '探针夹断' : '被夹断');
      if (!probeHit) badge2.style.opacity = '0.62';
      right.append(badge2);
    }
    row.append(right);

    row.addEventListener('pointerenter', () => cb.onHoverBatch(batch.index));
    row.addEventListener('pointerleave', () => cb.onHoverBatch(null));
    row.addEventListener('click', () => cb.onSelectBatch(batch.index));
    container.append(row);
  }
  if (plan.batches.length > MAX_ROWS) {
    container.append(
      el('div', 'muted small', `仅列出前 ${MAX_ROWS} 个批次，共 ${plan.batches.length} 个`),
    );
  }
}

export function renderInterruptionList(
  container: HTMLElement,
  plan: BatchPlan,
  cb: PanelCallbacks,
  focusPair: readonly [number, number] | null,
): void {
  container.replaceChildren();
  if (plan.interruptions.length === 0) {
    container.append(el('div', 'muted small', '本视野内没有"同层同混合却被夹断"的批次对。'));
    return;
  }
  const sorted = plan.interruptions
    .slice()
    .sort((a, b) => Number(b.viaProbe) - Number(a.viaProbe) || a.layer - b.layer || a.before - b.before);
  for (const it of sorted.slice(0, 6)) {
    const chip = el('button', 'pill on');
    if (!it.viaProbe) chip.style.opacity = '0.72';
    const focused = focusPair && focusPair[0] === it.before && focusPair[1] === it.after;
    if (focused) chip.style.outline = '1px solid #fff';
    chip.textContent = `${it.viaProbe ? '探针' : ''}第 ${it.layer + 1} 层 · #${it.before} ↔ #${it.after} 被 ${it.interrupters.join(',')} 夹断`;
    chip.title = '点击聚焦这两段批次与打断它们的批次';
    chip.addEventListener('click', () => cb.onFocusInterruption(it.before, it.after));
    container.append(chip);
  }
  if (sorted.length > 6) {
    container.append(el('div', 'muted small', `… 另有 ${sorted.length - 6} 对`));
  }
}

export function renderProbes(
  container: HTMLElement,
  plan: BatchPlan,
  sprites: readonly Sprite[],
  selectedId: number | null,
  cb: PanelCallbacks,
): void {
  container.replaceChildren();
  for (let si = 0; si < sprites.length; si++) {
    const sprite = sprites[si]!;
    if (!sprite.draggable) continue;
    const chip = el('button', 'probe-chip');
    if (sprite.id === selectedId) chip.classList.add('selected');
    const dot = el('span', 'dot');
    dot.style.background = sprite.blend === 'alpha' ? '#5bd6ff' : '#ffb45c';
    chip.append(dot, document.createTextNode(`${sprite.label} · ${sprite.blend === 'alpha' ? '普通' : '叠加'}`));
    const visible = plan.rankOfSprite[si]! >= 0;
    if (!visible) chip.style.opacity = '0.55';
    chip.addEventListener('click', () => cb.onSelectSprite(si));
    container.append(chip);
  }
}

export function renderProbeEditor(
  container: HTMLElement,
  plan: BatchPlan,
  sprites: readonly Sprite[],
  spriteIndex: number | null,
  scene: Scene,
  cb: PanelCallbacks,
): void {
  container.replaceChildren();
  if (spriteIndex === null) {
    container.append(el('div', 'muted small', '选中 A / B / C 探针后，可改它的层与混合设置。'));
    return;
  }
  const sprite = sprites[spriteIndex]!;
  if (!sprite.draggable) {
    container.append(el('div', 'muted small', `${sprite.label} 不是探针；只有 A/B/C 可改层。`));
    return;
  }
  const visible = plan.rankOfSprite[spriteIndex]! >= 0;
  const batch = plan.batchOfSprite[spriteIndex]!;

  const rowLayer = el('div', 'row between');
  rowLayer.append(el('span', 'muted', '所在层'));
  const select = el('select');
  for (let layer = 0; layer < scene.layerCount; layer++) {
    const opt = el('option', '', `第 ${layer + 1} 层 · ${scene.layerNames[layer]}`);
    opt.value = String(layer);
    if (layer === sprite.layer) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => cb.onSetProbeLayer(spriteIndex, Number(select.value)));
  rowLayer.append(select);
  container.append(rowLayer);

  const rowBlend = el('div', 'row between');
  rowBlend.append(el('span', 'muted', '混合设置'));
  const blendSelect = el('select');
  for (const [value, label] of [
    ['alpha', '普通透明'],
    ['additive', '叠加发光'],
  ] as const) {
    const opt = el('option', '', label);
    opt.value = value;
    if (value === sprite.blend) opt.selected = true;
    blendSelect.append(opt);
  }
  blendSelect.addEventListener('change', () =>
    cb.onSetProbeBlend(spriteIndex, blendSelect.value as 'alpha' | 'additive'),
  );
  rowBlend.append(blendSelect);
  container.append(rowBlend);

  const info = el('div', 'probe-info');
  const layerRange = plan.layerSpans.find((s) => s.layer === sprite.layer);
  const layerBatches = layerRange ? layerRange.batches.length : 0;
  info.innerHTML = visible
    ? `实际批次 <b>#${batch}</b> · 绘制位次 <b>${plan.rankOfSprite[spriteIndex]! + 1}</b> / ${plan.paintOrder.length}<br/>本层共 <b>${layerBatches}</b> 个批次`
    : `<b>已离开画面</b>：不入镜、不计批次。把它拖回或点"全图"。`;
  container.append(info);

  const actions = el('div', 'row gap');
  const up = el('button', '', '上一层');
  up.disabled = sprite.layer >= scene.layerCount - 1;
  up.addEventListener('click', () => cb.onSetProbeLayer(spriteIndex, Math.min(scene.layerCount - 1, sprite.layer + 1)));
  const down = el('button', '', '下一层');
  down.disabled = sprite.layer <= 0;
  down.addEventListener('click', () => cb.onSetProbeLayer(spriteIndex, Math.max(0, sprite.layer - 1)));
  actions.append(up, down);
  container.append(actions);
}

export interface DiffUiState {
  status: 'idle' | 'running' | 'done' | 'error';
  message?: string;
  diff?: BufferDiff;
  sceneKey?: string;
  when?: string;
}

export function renderDiff(container: HTMLElement, state: DiffUiState): void {
  container.replaceChildren();
  if (state.status === 'idle') {
    container.append(el('div', 'muted small', '点"读回并整幅比对"，或让画面停一下。'));
    return;
  }
  if (state.status === 'running') {
    container.append(el('div', 'muted small', '读回两条路径的 RGBA 缓冲…'));
    return;
  }
  if (state.status === 'error' || !state.diff) {
    container.append(el('div', 'diff-bad', state.message ?? '比对失败'));
    return;
  }
  const d = state.diff;
  const identical = d.diffPixels === 0;
  const line = (k: string, v: string, tone?: 'ok' | 'bad'): HTMLElement => {
    const row = el('div', 'diff-line');
    row.append(el('span', 'muted', k));
    row.append(el('b', tone ? `diff-${tone}` : '', v));
    return row;
  };
  const verdict = el('div', '', identical ? '✓ 两条路径逐像素一致' : '✗ 存在像素差异');
  verdict.className = identical ? 'diff-ok' : 'diff-bad';
  container.append(verdict);
  container.append(line('缓冲尺寸', `${d.width}×${d.height}`));
  container.append(line('不同像素', `${fmt(d.diffPixels)} / ${fmt(d.width * d.height)}`, identical ? 'ok' : 'bad'));
  container.append(line('单通道最大差', String(d.maxDelta), identical ? 'ok' : 'bad'));
  container.append(line('平均通道差', d.meanDelta.toFixed(4)));
  container.append(line('参考指纹', d.refHash));
  container.append(line('合批指纹', d.batchHash));
  if (state.when) container.append(el('div', 'muted small', `测于 ${state.when} · 场景 ${state.sceneKey ?? ''}`));
}

export function renderPixel(
  container: HTMLElement,
  sample: PixelSample | null,
  pos: { x: number; y: number } | null,
): void {
  container.replaceChildren();
  if (!sample || !pos) {
    container.append(el('div', 'muted small', '把鼠标移到画面上，查看同一像素在两条路径缓冲区里的 RGBA。'));
    return;
  }
  const header = el('div', 'muted small', `像素 (${pos.x}, ${pos.y})`);
  container.append(header);
  const wrap = el('div', 'pixel-swatches');
  const make = (name: string, rgba: readonly [number, number, number, number]): HTMLElement => {
    const box = el('div', 'pixel-swatch');
    const chip = el('span', 'chip');
    chip.style.background = `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`;
    box.append(chip);
    box.append(el('div', '', `${name}`));
    box.append(el('div', 'muted', `R ${rgba[0]} G ${rgba[1]}`));
    box.append(el('div', 'muted', `B ${rgba[2]} A ${rgba[3]}`));
    return box;
  };
  wrap.append(make('参考', sample.ref), make('合批', sample.batch));
  container.append(wrap);
  const delta = el(
    'div',
    sample.maxDelta === 0 ? 'diff-ok' : 'diff-bad',
    sample.maxDelta === 0 ? '该像素完全一致' : `该像素最大通道差 ${sample.maxDelta}`,
  );
  delta.style.marginTop = '0.3rem';
  container.append(delta);
}

export function renderTextures(container: HTMLElement, defs: readonly TextureDef[]): void {
  container.replaceChildren();
  for (const def of defs) {
    const item = el('div', 'texture-item');
    const canvas = el('canvas');
    canvas.width = def.size;
    canvas.height = def.size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(def.size, def.size);
      img.data.set(def.straight);
      ctx.putImageData(img, 0, 0);
    }
    item.append(canvas);
    item.append(el('b', '', def.name));
    item.append(el('span', '', def.edgeNote));
    item.title = `${def.key} · ${def.size}×${def.size} · 直通 alpha（预览） / 预乘 alpha（GPU）`;
    container.append(item);
  }
}

export function renderNotes(container: HTMLElement, scene: Scene): void {
  container.replaceChildren();
  for (const note of scene.notes) container.append(el('li', '', note));
  const li = el('li', '', `固定种子 0x${scene.seed.toString(16)}；同一场景重新载入的精灵分布完全相同。`);
  container.append(li);
}
