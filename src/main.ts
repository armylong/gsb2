import './style.css';
import { PotteryEngine } from './engine';
import { PATTERNS } from './patterns';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const canvas = $('disc') as HTMLCanvasElement;
const statusLine = $('status-line');
const patternSelect = $('pattern-select') as HTMLSelectElement;
const patternDesc = $('pattern-desc');
const pauseBtn = $('pause-btn') as HTMLButtonElement;
const rpmInput = $('rpm') as HTMLInputElement;
const rpmValue = $('rpm-value');
const widthInput = $('brush-width') as HTMLInputElement;
const widthValue = $('width-value');
const swatchesEl = $('swatches');
const paintBarsEl = $('paint-bars');
const scoreEl = $('score-result');
const importInput = $('import-file') as HTMLInputElement;

const engine = new PotteryEngine(canvas, { onStateChange: refresh });

// ---------- 目标花纹下拉 ----------
for (const p of PATTERNS) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.name;
  patternSelect.appendChild(opt);
}
patternSelect.value = engine.getPattern().id;
patternDesc.textContent = engine.getPattern().description;
patternSelect.addEventListener('change', () => {
  engine.setPattern(patternSelect.value);
  patternDesc.textContent = engine.getPattern().description;
});

// ---------- 色板 ----------
const swatchButtons: HTMLButtonElement[] = [];
engine.getBuckets().forEach((bucket, i) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'swatch';
  btn.style.background = bucket.color;
  btn.title = bucket.name;
  btn.addEventListener('click', () => engine.selectColor(i));
  swatchesEl.appendChild(btn);
  swatchButtons.push(btn);
});

// ---------- 控件接线 ----------
pauseBtn.addEventListener('click', () => engine.togglePause());
rpmInput.addEventListener('input', () => engine.setRpm(Number(rpmInput.value)));
widthInput.addEventListener('input', () =>
  engine.setBrushWidth(Number(widthInput.value)),
);
$('undo-btn').addEventListener('click', () => engine.undo());
$('clear-btn').addEventListener('click', () => {
  if (window.confirm('确定清空当前盘面吗？所有颜料会补满。')) engine.clearBoard();
});
$('check-btn').addEventListener('click', () => engine.checkCompletion());
$('clear-score-btn').addEventListener('click', () => engine.clearScore());

$('save-btn').addEventListener('click', () => {
  setStatus(engine.saveToStorage() ? '已保存到浏览器' : '保存失败：浏览器存储不可用');
});
$('load-btn').addEventListener('click', () => {
  if (engine.loadFromStorage()) {
    syncControlsFromEngine();
    setStatus('已读取浏览器存档，可以继续画');
  } else {
    setStatus('没有可用的浏览器存档');
  }
});
$('export-btn').addEventListener('click', () => engine.exportFile());
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  if (!file) return;
  try {
    await engine.importFile(file);
    syncControlsFromEngine();
    setStatus('已导入存档，可以继续画');
  } catch (err) {
    window.alert(`导入失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    importInput.value = '';
  }
});

// ---------- 快捷键 ----------
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    engine.undo();
  } else if (e.code === 'Space' && tag !== 'BUTTON' && tag !== 'INPUT' && tag !== 'SELECT') {
    e.preventDefault();
    engine.togglePause();
  }
});

// ---------- 刷子悬停预览 ----------
canvas.addEventListener('pointermove', (e) => {
  engine.setHover(engine.pointerToLocal(e.clientX, e.clientY));
});
canvas.addEventListener('pointerleave', () => engine.setHover(null));

function syncControlsFromEngine(): void {
  patternSelect.value = engine.getPattern().id;
  patternDesc.textContent = engine.getPattern().description;
  rpmInput.value = String(engine.rpm);
}

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function refresh(): void {
  pauseBtn.textContent = engine.paused ? '继续转动' : '暂停';
  rpmValue.textContent = String(engine.rpm);
  widthValue.textContent = String(engine.brushWidth);

  const buckets = engine.getBuckets();
  swatchButtons.forEach((btn, i) => {
    btn.classList.toggle('selected', i === engine.colorIndex);
    btn.classList.toggle('empty', buckets[i].remaining <= 0);
  });

  paintBarsEl.innerHTML = '';
  buckets.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'paint-row';
    const pct = Math.max(0, (b.remaining / b.capacity) * 100);
    row.innerHTML = `
      <span class="paint-name">${b.name}</span>
      <span class="paint-track"><span class="paint-fill" style="width:${pct}%;background:${b.color}"></span></span>
      <span class="paint-num">${Math.ceil(b.remaining)}</span>`;
    row.addEventListener('click', () => engine.selectColor(i));
    paintBarsEl.appendChild(row);
  });

  const score = engine.getScore();
  if (!score) {
    scoreEl.classList.add('hidden');
    scoreEl.textContent = '';
  } else {
    scoreEl.classList.remove('hidden');
    scoreEl.innerHTML = `
      <p class="${score.pass ? 'pass' : 'fail'}">
        ${score.pass ? '✓ 通过' : '✗ 未通过'}
      </p>
      <p>覆盖率：${(score.coverage * 100).toFixed(1)}%（漏涂 ${score.miss} 格）</p>
      <p>涂出 / 留白违规：${score.over} 格（占比 ${(score.overRate * 100).toFixed(1)}%）</p>
      <p class="legend"><span class="dot miss-dot"></span>蓝圈＝漏涂　<span class="dot over-dot"></span>红圈＝涂出</p>`;
  }

  const active = buckets[engine.colorIndex];
  if (engine.paused) setStatus(`已暂停 · 当前 ${active.name} 剩余 ${Math.ceil(active.remaining)}`);
  else setStatus(`转速 ${engine.rpm} rpm · 当前 ${active.name} 剩余 ${Math.ceil(active.remaining)}`);
}

refresh();
if (engine.hasStorageSave()) {
  engine.loadFromStorage();
  syncControlsFromEngine();
  setStatus('已自动恢复上次的盘面，可继续画');
}
