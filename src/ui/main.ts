import { colorCss, colorName, explainMix } from '../engine/colors.js';
import { canPlacePanel, flowerAt, movePanel, panelAt, simulateTurn } from '../engine/engine.js';
import { SCENARIOS, Scenario } from '../engine/scenarios.js';
import { Board, ColorCode, FlowerTurnDetail, TurnReport } from '../engine/types.js';
import { CELL, PAD, pixelToCell, render, RenderOptions } from './renderer.js';

interface Snapshot {
  board: Board;
  round: number;
  lastReport: TurnReport | null;
  reports: TurnReport[];
}

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const btnExecute = document.getElementById('btn-execute') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnLevel1 = document.getElementById('btn-level1') as HTMLButtonElement;
const btnLevel2 = document.getElementById('btn-level2') as HTMLButtonElement;
const hintEl = document.getElementById('hint') as HTMLParagraphElement;
const roundEl = document.getElementById('round-num') as HTMLSpanElement;
const scenarioNameEl = document.getElementById('scenario-name') as HTMLParagraphElement;
const taskBriefEl = document.getElementById('task-brief') as HTMLParagraphElement;
const taskDetailEl = document.getElementById('task-detail') as HTMLParagraphElement;
const goalStatusEl = document.getElementById('goal-status') as HTMLParagraphElement;
const inspectorEl = document.getElementById('inspector') as HTMLDivElement;

let scenario: Scenario = SCENARIOS[0]!;
let board: Board = structuredClone(scenario.board);
let round = 1;
let lastReport: TurnReport | null = null;
let reports: TurnReport[] = [];
const history: Snapshot[] = [];

let selectedPanelId: string | null = null;
let selectedFlowerId: string | null = null;
let hoverCell: { x: number; y: number } | null = null;

function pushHistory() {
  history.push({
    board: structuredClone(board),
    round,
    lastReport: lastReport ? structuredClone(lastReport) : null,
    reports: structuredClone(reports),
  });
}

function refreshGoal() {
  const result = scenario.check(reports);
  goalStatusEl.textContent = result.message;
  goalStatusEl.className = `goal-status ${result.complete ? 'ok' : 'todo'}`;
}

function pips(progress: number): string {
  const cells = [];
  for (let i = 0; i < 3; i += 1) {
    cells.push(`<span class="progress-pip ${i < progress ? 'on' : ''}"></span>`);
  }
  return `<span class="progress-track">${cells.join('')}</span>`;
}

function colorDot(color: ColorCode): string {
  return `<span class="dot" style="background:${colorCss(color)}"></span>${colorName(color)}`;
}

function renderInspector(detail: FlowerTurnDetail | null) {
  if (!detail) {
    inspectorEl.innerHTML = '执行一轮后点击任意花朵，查看本轮实际来源与颜色变化。';
    return;
  }
  const parts: string[] = [];
  parts.push(`<h3>花朵 ${detail.flowerId} · 第 ${lastReport?.round ?? ''} 轮结算</h3>`);
  parts.push(
    `<div class="row"><span>轮开始时颜色</span><span>${colorDot(detail.beforeColor)}</span></div>`,
  );

  if (detail.arrivals.length === 0) {
    parts.push('<div class="src-item">本轮没有花粉到达（空一轮，积累进度 −1）。</div>');
  } else {
    for (const arrival of detail.arrivals) {
      parts.push(
        `<div class="src-item">来源 ${arrival.sourceFlowerId} 经 ${arrival.windId} 吹来：${colorDot(
          arrival.sourceColor,
        )}</div>`,
      );
    }
    parts.push(
      `<div class="row"><span>混合规则</span><span>${explainMix(
        detail.arrivals.map((a) => a.sourceColor),
        detail.incomingColor,
      )}</span></div>`,
    );
  }

  parts.push(
    `<div class="row"><span>积累前</span><span>${colorName(
      detail.beforePendingColor,
    )} 进度 ${detail.beforeProgress}/3 ${pips(detail.beforeProgress)}</span></div>`,
  );
  parts.push(
    `<div class="row"><span>积累后</span><span>${colorName(
      detail.afterPendingColor,
    )} 进度 ${detail.afterProgress}/3 ${pips(detail.afterProgress)}</span></div>`,
  );
  parts.push(
    `<div class="row"><span>当前稳定颜色</span><strong>${colorDot(detail.afterColor)}</strong></div>`,
  );
  if (detail.stabilized) {
    parts.push('<div class="src-item">✅ 本轮完成连续 3 轮同色，稳定变色。</div>');
  }
  inspectorEl.innerHTML = parts.join('');
}

function draw() {
  const preview = simulateTurn(board, round);
  const options: RenderOptions = {
    lastReport,
    preview,
    selectedPanelId,
    selectedFlowerId,
    hoverCell,
  };
  render(ctx, board, options);
  roundEl.textContent = String(round);
  btnUndo.disabled = history.length === 0;

  if (selectedPanelId) {
    hintEl.textContent = '已选中挡风板：点击空格放下（不能压花或重叠），再次点击该挡板取消选择。';
  } else {
    hintEl.textContent = '点击挡风板拿起，再点目标格移动；虚线是本轮传播路径预看。';
  }
  refreshGoal();
}

function executeTurn() {
  pushHistory();
  const report = simulateTurn(board, round);
  lastReport = report;
  reports.push(report);
  board = report.board;
  round += 1;
  selectedPanelId = null;
  selectedFlowerId = null;
  inspectorEl.innerHTML = '点击任意花朵，查看刚才这一轮的实际来源与颜色变化。';
  draw();
}

function undo() {
  const snapshot = history.pop();
  if (!snapshot) return;
  board = snapshot.board;
  round = snapshot.round;
  lastReport = snapshot.lastReport;
  reports = snapshot.reports;
  selectedPanelId = null;
  selectedFlowerId = null;
  renderInspector(null);
  draw();
}

function resetLevel() {
  board = structuredClone(scenario.board);
  round = 1;
  lastReport = null;
  reports = [];
  history.length = 0;
  selectedPanelId = null;
  selectedFlowerId = null;
  renderInspector(null);
  draw();
}

function loadScenario(index: number) {
  scenario = SCENARIOS[index]!;
  scenarioNameEl.textContent = scenario.name;
  taskBriefEl.textContent = scenario.brief;
  taskDetailEl.textContent = scenario.task;
  resetLevel();
}

canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (event.clientX - rect.left) * scaleX;
  const py = (event.clientY - rect.top) * scaleY;
  const cell = pixelToCell(board, px, py);
  if (!cell) return;

  const panel = panelAt(board, cell.x, cell.y);
  const flower = flowerAt(board, cell.x, cell.y);

  // 已拿起挡板 -> 尝试放下
  if (selectedPanelId) {
    if (panel && panel.id === selectedPanelId) {
      selectedPanelId = null; // 放回原位
    } else if (canPlacePanel(board, cell.x, cell.y)) {
      pushHistory();
      board = movePanel(board, selectedPanelId, cell);
      selectedPanelId = null;
    } else {
      hintEl.textContent = '这里不能放挡板（花上或已有挡板）。';
    }
    draw();
    return;
  }

  if (panel) {
    selectedPanelId = panel.id;
    selectedFlowerId = null;
    draw();
    return;
  }

  if (flower) {
    selectedFlowerId = flower.id;
    const detail = lastReport?.details.find((d) => d.flowerId === flower.id) ?? null;
    renderInspector(detail);
    draw();
  }
});

canvas.addEventListener('mousemove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  hoverCell = pixelToCell(
    board,
    (event.clientX - rect.left) * scaleX,
    (event.clientY - rect.top) * scaleY,
  );
  draw();
});

canvas.addEventListener('mouseleave', () => {
  hoverCell = null;
  draw();
});

btnExecute.addEventListener('click', executeTurn);
btnUndo.addEventListener('click', undo);
btnReset.addEventListener('click', resetLevel);
btnLevel1.addEventListener('click', () => loadScenario(0));
btnLevel2.addEventListener('click', () => loadScenario(1));

// 关卡切换：键盘 1 / 2 作为快捷键
window.addEventListener('keydown', (event) => {
  if (event.key === '1') loadScenario(0);
  if (event.key === '2') loadScenario(1);
});

// 让 canvas 的逻辑尺寸随地图大小自适应（两关都是 6×5）
canvas.width = PAD * 2 + scenario.board.width * CELL;
canvas.height = PAD * 2 + scenario.board.height * CELL;

loadScenario(0);
