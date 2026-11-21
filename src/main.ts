import './ui/style.css';
import { keyOf } from './grid.ts';
import { EXAMPLES, exampleById, type ExampleDef } from './examples.ts';
import type { RoundRecord } from './sim.ts';
import { MEDIA, MEDIUM_LABEL, MEDIUM_UNIT, UNIT_SCALE, type Medium } from './units.ts';
import { MAX_ROUNDS, SimulationSession, layoutToEdits } from './session.ts';
import { runChecks, type CheckResult } from './checks.ts';
import {
  COLORS,
  PAD,
  cellAtPoint,
  contentLabel,
  drawScene,
  metricsFor,
  type GridMetrics,
  type Selection,
} from './ui/render.ts';

type ToolId = 'inspect' | 'wall' | 'source-heat' | 'source-fog' | 'vent-heat' | 'vent-fog' | 'vent-both' | 'valve' | 'erase';

interface ToolDef {
  id: ToolId;
  label: string;
  hint: string;
}

const TOOLS: ToolDef[] = [
  { id: 'inspect', label: '查看', hint: '点选格子，查看上一轮与本轮的来源、扩散、释放账目。' },
  { id: 'wall', label: '墙', hint: '封闭格子；任何介质都不能穿过墙。' },
  { id: 'source-heat', label: '热源', hint: '每轮向所在格注入固定热量（HU）。' },
  { id: 'source-fog', label: '雾源', hint: '每轮向所在格注入固定雾量（FU）。' },
  { id: 'vent-heat', label: '热风口', hint: '可开关；开启时把本格热量排到界外，每轮最多 2 HU。' },
  { id: 'vent-fog', label: '雾风口', hint: '可开关；开启时把本格雾排到界外，每轮最多 1.2 FU。' },
  { id: 'vent-both', label: '双风口', hint: '可开关；同时释放热量与雾，速率各自独立。' },
  { id: 'valve', label: '单向阀', hint: '先点起点格，再点相邻格；箭头指向允许通过的方向。' },
  { id: 'erase', label: '擦除', hint: '清除格子内容，以及与该格相连的所有单向阀。' },
];

const session = new SimulationSession(EXAMPLES[0]!);
let tool: ToolId = 'inspect';
let selection: Selection | null = { x: 3, y: 4 };
let hover: Selection | null = null;
let pendingValve: Selection | null = null;
let showFocus = true;
let metrics: GridMetrics = metricsFor(900);

const dom = {
  canvas: required<HTMLCanvasElement>('grid'),
  canvasWrap: required<HTMLDivElement>('canvas-wrap'),
  exampleSelect: required<HTMLSelectElement>('example-select'),
  toolGrid: required<HTMLDivElement>('tool-grid'),
  valveReverse: required<HTMLInputElement>('valve-reverse'),
  showFocus: required<HTMLInputElement>('show-focus'),
  roundLabel: required<HTMLElement>('round-label'),
  roundTip: required<HTMLElement>('round-tip'),
  roundPill: required<HTMLElement>('round-pill'),
  roundSummary: required<HTMLDivElement>('round-summary'),
  cellPill: required<HTMLElement>('cell-pill'),
  cellDetail: required<HTMLDivElement>('cell-detail'),
  branchList: required<HTMLDivElement>('branch-list'),
  checkResults: required<HTMLDivElement>('check-results'),
  orderResults: required<HTMLDivElement>('order-results'),
  spark: required<HTMLCanvasElement>('spark'),
  toast: required<HTMLDivElement>('toast'),
  hint: required<HTMLElement>('hint'),
  scrub: required<HTMLInputElement>('round-scrub'),
  scrubLabel: required<HTMLElement>('scrub-label'),
  exampleSummary: required<HTMLElement>('example-summary'),
  exampleExpects: required<HTMLUListElement>('example-expects'),
};

function required<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function init(): void {
  for (const example of EXAMPLES) {
    const option = document.createElement('option');
    option.value = example.id;
    option.textContent = example.name;
    dom.exampleSelect.append(option);
  }
  dom.exampleSelect.value = EXAMPLES[0]!.id;

  for (const item of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.dataset.tool = item.id;
    button.setAttribute('aria-pressed', String(item.id === tool));
    const strong = document.createElement('strong');
    strong.textContent = item.label;
    const span = document.createElement('span');
    span.textContent = toolKeyword(item.id);
    button.append(strong, span);
    button.addEventListener('click', () => {
      selectTool(item.id);
    });
    dom.toolGrid.append(button);
  }

  bindTransport();
  bindCanvas();
  bindPanels();
  loadExample(EXAMPLES[0]!);
  selectTool('inspect');

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight' || event.key === ' ') {
      event.preventDefault();
      step(1);
    }
  });

  const observer = new ResizeObserver(() => {
    resizeCanvas();
    render();
  });
  observer.observe(dom.canvasWrap);
}

function toolKeyword(id: ToolId): string {
  switch (id) {
    case 'inspect':
      return '点格查询';
    case 'wall':
      return '阻断';
    case 'source-heat':
      return '注入 HU';
    case 'source-fog':
      return '注入 FU';
    case 'vent-heat':
      return '释放 HU';
    case 'vent-fog':
      return '释放 FU';
    case 'vent-both':
      return '释放两种';
    case 'valve':
      return '定向';
    case 'erase':
      return '清除';
  }
}

function selectTool(next: ToolId): void {
  tool = next;
  pendingValve = null;
  for (const button of dom.toolGrid.querySelectorAll<HTMLButtonElement>('button.tool')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === next));
  }
  dom.hint.textContent = TOOLS.find((item) => item.id === next)?.hint ?? '';
  dom.canvas.style.cursor = next === 'inspect' ? 'pointer' : 'crosshair';
  render();
}

function loadExample(example: ExampleDef): void {
  session.loadExample(example);
  selection = example.focus[0] ? { x: example.focus[0].x, y: example.focus[0].y } : null;
  pendingValve = null;
  // 预演 6 轮，视图停在最新一轮；用 ◀ / ▶ 或时间轴回看任意轮。
  session.advance(6);
  session.setViewRound(session.tipRound());
  dom.exampleSummary.textContent = example.summary;
  dom.exampleExpects.replaceChildren(
    ...example.expects.map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }),
  );
  renderAll();
  toast(`已载入示例：${example.name}，可点 ▶ 逐轮推进`);
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

function bindTransport(): void {
  required<HTMLButtonElement>('btn-prev').addEventListener('click', () => step(-1));
  required<HTMLButtonElement>('btn-next').addEventListener('click', () => step(1));
  required<HTMLButtonElement>('btn-first').addEventListener('click', () => {
    session.setViewRound(session.active().baseRound);
    renderAll();
  });
  required<HTMLButtonElement>('btn-step').addEventListener('click', () => {
    if (session.isAtTip()) session.advance(1);
    else session.setViewRound(session.viewRound + 1);
    renderAll();
  });
  required<HTMLButtonElement>('btn-run').addEventListener('click', () => {
    // 历史视图下只向前回放，不追加新轮次；要追加请先回到最新一轮。
    if (!session.isAtTip()) {
      const target = Math.min(session.tipRound(), session.viewRound + 5);
      session.setViewRound(target);
      renderAll();
      toast(`回放至第 ${target} 轮（最新为第 ${session.tipRound()} 轮）`);
      return;
    }
    const added = session.advance(5);
    if (added === 0) toast('已达到本分支的演算上限');
    renderAll();
  });
  required<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
    session.resetBranch();
    renderAll();
    toast('已清空本分支演算记录');
  });
  required<HTMLButtonElement>('btn-fork').addEventListener('click', () => {
    const info = session.fork();
    renderAll();
    toast(`已从第 ${info.round} 轮分叉，父分支保持不变`);
  });
  dom.scrub.addEventListener('input', () => {
    session.setViewRound(Number(dom.scrub.value));
    renderAll();
  });
  dom.exampleSelect.addEventListener('change', () => {
    const example = exampleById(dom.exampleSelect.value);
    loadExample(example);
  });
  dom.showFocus.addEventListener('change', () => {
    showFocus = dom.showFocus.checked;
    render();
  });
}

function step(delta: number): void {
  if (delta > 0 && session.isAtTip()) {
    session.advance(1);
  } else {
    session.setViewRound(session.viewRound + delta);
  }
  renderAll();
}

function bindCanvas(): void {
  const canvas = dom.canvas;
  canvas.addEventListener('pointermove', (event) => {
    const point = pointToCell(event);
    if (point?.x === hover?.x && point?.y === hover?.y) return;
    hover = point;
    render();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    render();
  });
  canvas.addEventListener('click', (event) => {
    const point = pointToCell(event);
    if (!point) return;
    handleCellClick(point);
  });
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const point = pointToCell(event);
    if (!point) return;
    eraseAt(point);
  });
}

function pointToCell(event: PointerEvent | MouseEvent): { x: number; y: number } | null {
  const rect = dom.canvas.getBoundingClientRect();
  return cellAtPoint(
    ((event.clientX - rect.left) / rect.width) * metrics.w,
    ((event.clientY - rect.top) / rect.height) * metrics.h,
    metrics,
  );
}

function handleCellClick(point: { x: number; y: number }): void {
  selection = point;
  if (tool === 'inspect') {
    renderAll();
    return;
  }
  if (tool === 'erase') {
    eraseAt(point);
    return;
  }
  if (tool === 'valve') {
    handleValveClick(point);
    return;
  }

  guardHistoryEdit(() => {
    session.updateLayout((layout) => {
      if (tool === 'wall') {
        layout.setCell(point.x, point.y, { kind: 'wall' });
      } else if (tool === 'source-heat' || tool === 'source-fog') {
        const medium: Medium = tool === 'source-heat' ? 'heat' : 'fog';
        const existing = layout.getCell(point.x, point.y);
        const amount =
          existing?.kind === 'source' && existing.medium === medium
            ? existing.amount
            : medium === 'heat'
              ? 6_000
              : 4_000;
        layout.setCell(point.x, point.y, { kind: 'source', medium, amount });
      } else if (tool === 'vent-heat' || tool === 'vent-fog' || tool === 'vent-both') {
        const medium = tool === 'vent-heat' ? 'heat' : tool === 'vent-fog' ? 'fog' : 'both';
        layout.setCell(point.x, point.y, { kind: 'vent', medium, open: true });
      }
    });
  });
  renderAll();
}

function handleValveClick(point: { x: number; y: number }): void {
  if (!pendingValve) {
    pendingValve = point;
    toast('已选起点，请点击相邻格作为另一端');
    render();
    return;
  }
  const dx = Math.abs(pendingValve.x - point.x);
  const dy = Math.abs(pendingValve.y - point.y);
  if (dx + dy !== 1) {
    pendingValve = point;
    toast('两端必须上下左右相邻，已重新选择起点');
    render();
    return;
  }
  const from = pendingValve;
  const to = point;
  pendingValve = null;
  guardHistoryEdit(() => {
    session.updateLayout((layout) => {
      const reversed = dom.valveReverse.checked;
      layout.setValve(keyOf(from.x, from.y), keyOf(to.x, to.y), !reversed);
    });
  });
  renderAll();
}

function eraseAt(point: { x: number; y: number }): void {
  selection = point;
  guardHistoryEdit(() => {
    session.updateLayout((layout) => {
      layout.setCell(point.x, point.y, null);
      const key = keyOf(point.x, point.y);
      for (const valve of layout.valvesAt(key)) {
        layout.setValve(valve.a, valve.b, null);
      }
    });
  });
  renderAll();
}

/**
 * 历史视图下修改布局 = 自动分叉后在新分支上修改，
 * 这样父分支的旧轮次永远可回溯。
 */
function guardHistoryEdit(mutate: () => void): void {
  if (session.editNeedsFork()) {
    const round = session.viewRound;
    session.fork(`第 ${round} 轮试验`);
    toast(`已在第 ${round} 轮自动分叉，原分支历史保留`);
  }
  mutate();
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */

function bindPanels(): void {
  dom.valveReverse.addEventListener('change', () => {
    if (pendingValve) toast('方向设置已更新，请点击终点');
  });
  required<HTMLButtonElement>('btn-checks').addEventListener('click', () => {
    const [sealed, valve, dual] = EXAMPLES;
    const results = runChecks(sealed!.edits, valve!.edits, dual!.edits, {
      sealedBox: { x0: 3, y0: 2, x1: 9, y1: 8 },
    });
    renderChecks(dom.checkResults, results);
    const failed = results.filter((item) => !item.passed).length;
    toast(failed === 0 ? '全部验证通过' : `${failed} 项验证未通过`);
  });
  required<HTMLButtonElement>('btn-order-check').addEventListener('click', () => {
    const result = session.selfCheck(Math.max(6, Math.min(12, session.active().records.length || 8)));
    dom.orderResults.replaceChildren();
    const item = document.createElement('div');
    item.className = 'check-item';
    item.append(statusDot(result.identical));
    const header = document.createElement('header');
    header.append(statusDot(result.identical), textSpan(result.identical ? '四种编辑顺序结果一致' : '结果不一致'));
    const body = document.createElement('p');
    body.textContent = result.orders
      .map((order) => `${order.name}: ${order.hash}`)
      .join(' · ');
    item.append(header, body);
    if (result.ledgerErrors.length > 0) {
      const errors = document.createElement('p');
      errors.textContent = result.ledgerErrors.slice(0, 3).join('；');
      item.append(errors);
    }
    dom.orderResults.append(item);
    toast(result.identical ? '编辑顺序自检通过' : '编辑顺序自检失败');
  });
}

function renderAll(): void {
  render();
  renderRound();
  renderCellDetail();
  renderBranches();
  spark();
}

function render(): void {
  resizeCanvas();
  const ctx = dom.canvas.getContext('2d');
  if (!ctx) return;
  const branch = session.active();
  const state = session.stateAt(session.viewRound);
  const layout = branch.layout;
  ctx.save();
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  drawScene(ctx, metrics, {
    layout,
    state,
    selection,
    hover,
    pendingValve,
    focus: currentExampleFocus(),
    showFocus,
  });
  ctx.restore();

  dom.roundLabel.textContent = `第 ${session.viewRound} 轮`;
  const base = branch.baseRound;
  dom.roundTip.textContent =
    session.isAtTip()
      ? `已到本分支最新一轮（起点第 ${base} 轮）`
      : `历史视图 · 第 ${session.viewRound} / ${session.tipRound()} 轮`;
  dom.scrub.min = String(branch.baseRound);
  dom.scrub.max = String(session.tipRound());
  dom.scrub.value = String(session.viewRound);
  dom.scrubLabel.textContent = `${session.viewRound} / ${session.tipRound()}`;
}

function currentExampleFocus(): ReadonlyArray<{ x: number; y: number; label: string }> {
  const example = EXAMPLES.find((item) => item.id === dom.exampleSelect.value);
  return example?.focus ?? [];
}

function resizeCanvas(): void {
  const available = Math.max(420, dom.canvasWrap.clientWidth || 900);
  metrics = metricsFor(available);
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(metrics.w);
  const height = Math.round(metrics.h);
  if (dom.canvas.width !== Math.round(width * dpr) || dom.canvas.height !== Math.round(height * dpr)) {
    dom.canvas.width = Math.round(width * dpr);
    dom.canvas.height = Math.round(height * dpr);
  }
  dom.canvas.style.width = `${width}px`;
  dom.canvas.style.height = `${height}px`;
}

function renderRound(): void {
  const record = session.recordAt(session.viewRound);
  const branch = session.active();
  const inherited =
    branch.baseRound > 0 && session.viewRound <= branch.baseRound && record !== null;
  dom.roundPill.textContent =
    session.viewRound === 0
      ? '起始'
      : inherited
        ? `第 ${session.viewRound} 轮 · 继承自分叉前`
        : `第 ${session.viewRound} 轮${branch.baseRound > 0 ? ` · 分叉于第 ${branch.baseRound} 轮` : ''}`;
  // 继承轮次是按“分叉时布局”结算的；分叉后改建不影响这些旧账目。
  const forkLayoutHash = branch.inherited[branch.inherited.length - 1]?.layoutHash;
  const layoutChangedSinceInherited =
    inherited && forkLayoutHash !== undefined && forkLayoutHash !== branch.layout.hash();
  dom.roundSummary.replaceChildren();

  if (!record) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      session.viewRound === branch.baseRound
        ? `这是分支起点（第 ${branch.baseRound} 轮末状态）。再演算一轮即可看到本分支的来源、扩散与释放。`
        : '没有该轮记录。';
    dom.roundSummary.append(empty);
    return;
  }

  if (layoutChangedSinceInherited) {
    const note = document.createElement('p');
    note.className = 'notice';
    note.textContent = `这一轮继承自分叉前，按分叉时的布局结算；当前的改建会从第 ${
      branch.baseRound + 1
    } 轮起生效。`;
    dom.roundSummary.append(note);
  }

  for (const medium of MEDIA) {
    const totals = record.totals[medium];
    const card = document.createElement('div');
    card.className = 'medium-row';
    const head = document.createElement('div');
    head.className = 'medium-head';
    head.append(dot(medium), textSpan(MEDIUM_LABEL[medium], 'strong'), textSpan(`单位 ${MEDIUM_UNIT[medium]}`, 'muted small'));
    card.append(head);

    const metricsList = document.createElement('dl');
    metricsList.className = 'metrics';
    const entries: Array<[string, number]> = [
      ['期初存量', totals.opening],
      ['本轮注入', totals.injected],
      ['本轮释放', totals.released],
      ['格间转出合计', totals.diffused],
      ['因改建清除', totals.cleared],
      ['期末存量', totals.inMap],
    ];
    for (const [label, value] of entries) {
      const cell = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = formatMilli(value, medium);
      cell.append(dt, dd);
      metricsList.append(cell);
    }
    card.append(metricsList);

    const balance = document.createElement('div');
    const ok = totals.opening + totals.injected === totals.inMap + totals.released;
    balance.className = `balance${ok ? '' : ' bad'}`;
    balance.textContent = ok
      ? `对账：期初 ${formatMilli(totals.opening, medium)} + 注入 ${formatMilli(
          totals.injected,
          medium,
        )} = 期末 ${formatMilli(totals.inMap, medium)} + 释放 ${formatMilli(totals.released, medium)}`
      : `对账失败：${formatMilli(totals.opening, medium)} + ${formatMilli(
          totals.injected,
          medium,
        )} ≠ ${formatMilli(totals.inMap, medium)} + ${formatMilli(totals.released, medium)}`;
    card.append(balance);
    dom.roundSummary.append(card);
  }
}

function renderCellDetail(): void {
  const branch = session.active();
  dom.cellDetail.replaceChildren();
  if (!selection) {
    dom.cellPill.textContent = '未选择';
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '用「查看」工具点击任意格子。';
    dom.cellDetail.append(empty);
    return;
  }
  const { x, y } = selection;
  const key = keyOf(x, y);
  const content = branch.layout.getCell(x, y);
  dom.cellPill.textContent = `(${x}, ${y})`;

  const meta = document.createElement('div');
  meta.className = 'cell-meta';
  meta.append(textSpan(contentLabel(content)), textSpan('·'), textSpan(`键 ${key}`, 'muted'));

  const actions = document.createElement('div');
  actions.className = 'flows';
  if (content?.kind === 'vent') {
    actions.append(
      actionButton(content.open ? '关闭风口' : '开启风口', () => {
        guardHistoryEdit(() => {
          session.updateLayout((layout) => {
            layout.setCell(x, y, { ...content, open: !content.open });
          });
        });
        renderAll();
      }),
    );
  }
  if (content?.kind === 'source') {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const label = document.createElement('span');
    label.textContent = `每轮注入（${MEDIUM_UNIT[content.medium]}）`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.001';
    input.step = '0.5';
    input.value = String(content.amount / UNIT_SCALE);
    input.style.width = '84px';
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        input.value = String(content.amount / UNIT_SCALE);
        toast('注入量必须是正数');
        return;
      }
      const amount = Math.max(1, Math.round(parsed * UNIT_SCALE));
      guardHistoryEdit(() => {
        session.updateLayout((layout) => {
          layout.setCell(x, y, { kind: 'source', medium: content.medium, amount });
        });
      });
      renderAll();
    });
    wrap.append(label, input);
    actions.append(wrap);
  }
  if (content) {
    actions.append(
      actionButton('清除此格', () => {
        eraseAt(selection!);
      }),
    );
  }
  meta.append(actions);
  dom.cellDetail.append(meta);

  const valves = branch.layout
    .valvesAt(key)
    .map((valve) => {
      const allows = valve.a === key ? valve.b : valve.a;
      const row = document.createElement('div');
      row.className = 'flows';
      const chip = document.createElement('span');
      chip.className = 'chip out';
      chip.textContent = `${key} → ${allows}`;
      row.append(chip);
      row.append(
        actionButton('反向', () => {
          guardHistoryEdit(() => {
            session.updateLayout((layout) => {
              layout.setValve(valve.a, valve.b, !valve.allowAtoB);
            });
          });
          renderAll();
        }),
        actionButton('移除', () => {
          guardHistoryEdit(() => {
            session.updateLayout((layout) => {
              layout.setValve(valve.a, valve.b, null);
            });
          });
          renderAll();
        }),
      );
      return row;
    })
    .filter((row) => row.childElementCount > 0);
  if (valves.length > 0) {
    const valveBox = document.createElement('div');
    valveBox.className = 'cell-detail';
    const title = document.createElement('h3');
    title.textContent = '相邻单向阀';
    valveBox.append(title, ...valves);
    dom.cellDetail.append(valveBox);
  }

  const current = session.recordAt(session.viewRound);
  const previous = session.recordAt(session.viewRound - 1);
  const grid = document.createElement('div');
  grid.className = 'compare';
  grid.append(
    ledgerCard('上一轮贡献', previous, key, session.viewRound - 1),
    ledgerCard('本轮贡献', current, key, session.viewRound),
  );
  dom.cellDetail.append(grid);
}

function ledgerCard(
  title: string,
  record: RoundRecord | null,
  key: string,
  round: number,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'compare-card';
  const head = document.createElement('div');
  head.className = 'ledger-head';
  const h = document.createElement('h4');
  h.textContent = title;
  head.append(h, textSpan(round > 0 ? `R${round}` : '—', 'muted small'));
  card.append(head);

  const entry = record?.ledger.get(key);
  if (!entry) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      round <= 0
        ? '第 0 轮之前没有记录'
        : round === session.active().baseRound
          ? '该轮是分叉起点（不产生新账目）'
          : '无记录（该格不存在）';
    card.append(empty);
    return card;
  }

  for (const medium of MEDIA) {
    const cell = entry[medium];
    const section = document.createElement('div');
    section.style.marginBottom = '8px';

    const label = document.createElement('div');
    label.className = 'ledger-head';
    label.append(dot(medium), textSpan(MEDIUM_LABEL[medium], 'small'));
    const delta = document.createElement('span');
    const net = cell.closing - cell.opening;
    delta.className = `delta ${net > 0 ? 'up' : net < 0 ? 'down' : 'muted'}`;
    delta.textContent = `${net >= 0 ? '+' : ''}${formatMilli(net, medium)}`;
    label.append(delta);

    const grid = document.createElement('dl');
    grid.className = 'ledger-grid';
    addLedgerRow(grid, '期初', formatMilli(cell.opening, medium));
    addLedgerRow(grid, '来源注入', formatMilli(cell.injected, medium));
    addLedgerRow(grid, '流入', flowChips(cell.inflows, 'in', medium));
    addLedgerRow(grid, '流出', flowChips(cell.outflows, 'out', medium));
    addLedgerRow(grid, '风口释放', formatMilli(cell.released, medium));
    addLedgerRow(grid, '期末', formatMilli(cell.closing, medium));
    section.append(label, grid);
    card.append(section);
  }
  return card;
}

function addLedgerRow(list: HTMLElement, label: string, value: string | HTMLElement): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (typeof value === 'string') dd.textContent = value;
  else dd.append(value);
  list.append(dt, dd);
}

function flowChips(
  flows: readonly { cell: string; amount: number }[],
  kind: 'in' | 'out',
  medium: Medium,
): HTMLElement {
  if (flows.length === 0) {
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = '—';
    return span;
  }
  const wrap = document.createElement('div');
  wrap.className = 'flows';
  for (const flow of flows) {
    const chip = document.createElement('span');
    chip.className = `chip ${kind}`;
    chip.textContent = `${kind === 'in' ? '从' : '到'} ${flow.cell} ${formatMilli(flow.amount, medium)}`;
    wrap.append(chip);
  }
  return wrap;
}

function renderBranches(): void {
  dom.branchList.replaceChildren();
  for (const branch of session.branches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'branch';
    button.setAttribute('aria-current', String(branch.id === session.activeId));
    const name = document.createElement('span');
    name.className = 'name';
    const title = document.createElement('span');
    title.textContent = branch.name;
    const sub = document.createElement('small');
    sub.textContent =
      branch.parentId === null
        ? `根分支 · 0→${branch.records.length} 轮`
        : `第 ${branch.forkRound} 轮分出 · 历史 1–${branch.baseRound} 继承 · 试验 ${branch.baseRound + 1}–${branch.baseRound + branch.records.length} 轮`;
    name.append(title, sub);
    const count = document.createElement('span');
    count.className = 'pill';
    count.textContent = branch.id;
    button.append(name, count);
    button.addEventListener('click', () => {
      session.setActive(branch.id);
      renderAll();
    });
    dom.branchList.append(button);
  }
}

function renderChecks(container: HTMLElement, results: readonly CheckResult[]): void {
  container.replaceChildren();
  for (const result of results) {
    const item = document.createElement('div');
    item.className = 'check-item';
    const header = document.createElement('header');
    header.append(statusDot(result.passed), textSpan(result.title));
    const detail = document.createElement('p');
    detail.textContent = result.detail;
    item.append(header, detail);
    container.append(item);
  }
}

/* ------------------------------------------------------------------ */
/* 小图表：历轮释放（两种介质分面，各自量纲）                          */
/* ------------------------------------------------------------------ */

function spark(): void {
  const canvas = dom.spark;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(240, Math.round(rect.width || 320));
  const height = 96;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const branch = session.active();
  const records = session.allRecords();
  const rows: Array<{ medium: Medium; top: number; height: number }> = [
    { medium: 'heat', top: 14, height: 26 },
    { medium: 'fog', top: 58, height: 26 },
  ];

  for (const row of rows) {
    const values = records.map((record) => record.totals[row.medium].released);
    const max = Math.max(1, ...values);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`${MEDIUM_LABEL[row.medium]} · ${MEDIUM_UNIT[row.medium]}`, 0, row.top - 6);

    const plotLeft = 54;
    const plotRight = width - 4;
    const plotW = Math.max(10, plotRight - plotLeft);
    const baseY = row.top + row.height;
    ctx.strokeStyle = COLORS.gridline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, Math.round(baseY) + 0.5);
    ctx.lineTo(plotRight, Math.round(baseY) + 0.5);
    ctx.stroke();

    if (records.length === 0) continue;
    const stepX = plotW / Math.max(1, records.length);
    const barW = Math.max(1.5, Math.min(6, stepX - 1));
    values.forEach((value, index) => {
      const x = plotLeft + index * stepX + (stepX - barW) / 2;
      if (value <= 0) return;
      const h = Math.max(1.5, (value / max) * (row.height - 2));
      ctx.fillStyle = row.medium === 'heat' ? COLORS.heat : COLORS.fog;
      ctx.beginPath();
      const r = Math.min(2, barW / 2);
      const y = baseY - h;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + barW, y, x + barW, y + h, r);
      ctx.arcTo(x + barW, y + h, x, y + h, 0);
      ctx.arcTo(x, y + h, x, y, 0);
      ctx.arcTo(x, y, x + barW, y, r);
      ctx.closePath();
      ctx.fill();
    });

    // 分叉点：继承历史与本次试验的分界
    if (branch.inherited.length > 0 && branch.inherited.length < records.length) {
      const boundary = plotLeft + branch.inherited.length * stepX;
      ctx.strokeStyle = COLORS.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(boundary) + 0.5, row.top - 2);
      ctx.lineTo(Math.round(boundary) + 0.5, baseY);
      ctx.stroke();
    }

    // 当前查看轮次的标记
    const currentIndex = session.viewRound - 1;
    if (currentIndex >= 0 && currentIndex < records.length) {
      const x = plotLeft + currentIndex * stepX + stepX / 2;
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, row.top - 2);
      ctx.lineTo(Math.round(x) + 0.5, baseY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const hasRelease = values.some((value) => value > 0);
    ctx.fillStyle = COLORS.secondary;
    ctx.textAlign = 'right';
    ctx.fillText(hasRelease ? `峰值 ${formatMilli(max, row.medium)}` : '尚无释放', plotRight, row.top - 6);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function formatMilli(value: number, medium: Medium): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / UNIT_SCALE);
  const frac = abs % UNIT_SCALE;
  if (frac === 0) return `${sign}${whole} ${MEDIUM_UNIT[medium]}`;
  return `${sign}${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')} ${MEDIUM_UNIT[medium]}`;
}

function textSpan(text: string, className?: string): HTMLSpanElement {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

function dot(medium: Medium): HTMLElement {
  const span = document.createElement('span');
  span.className = `dot ${medium}`;
  return span;
}

function statusDot(passed: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = `status ${passed ? 'pass' : 'fail'}`;
  span.title = passed ? '通过' : '未通过';
  return span;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

let toastTimer: number | undefined;
function toast(message: string): void {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove('show');
  }, 2600);
}

// 供浏览器控制台手动核查：session 为只读快照，edits 便于和验证命令对照。
Object.defineProperty(window, 'sandbox', {
  value: {
    get session() {
      return session;
    },
    get edits() {
      return layoutToEdits(session.active().layout);
    },
    get maxRounds() {
      return MAX_ROUNDS;
    },
    get constants() {
      return { UNIT_SCALE, MEDIA };
    },
    cellKey: keyOf,
    PAD,
  },
  configurable: false,
});

init();
