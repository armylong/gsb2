/**
 * main.ts — DOM 界面与交互装配；规则全部来自 game.ts / engine.ts。
 */
import { GameStore } from './game';
import { LEVELS } from './levels';
import { ScaleRenderer, type ScaleView } from './render';
import { OUTCOME_TEXT, sumOf, type Outcome, type PartitionVerdict } from './engine';

const store = new GameStore(0);

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
};

const esc = (s: string | number): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const outcomeClass = (o: Outcome): string => (o === 1 ? 'o1' : o === 0 ? 'o0' : 'o_1');
const outcomeLabel = (o: Outcome): string => OUTCOME_TEXT[o];

/* ---------------- Canvas ---------------- */

const canvas = $<HTMLCanvasElement>('#scaleCanvas');
const renderer = new ScaleRenderer(canvas);
renderer.onPackageClick = (pkg) => {
  // 仅在翻查当前摆法时，点盘上包裹将其取下
  if (store.state.viewing === 'draft') store.setTray(pkg, null);
};

function currentScaleView(): ScaleView {
  const s = store.state;
  if (s.viewing === 'draft' || typeof s.viewing !== 'number') {
    const d = store.draftSides();
    return { left: d.left, right: d.right, outcome: null };
  }
  const rec = s.records[s.viewing];
  if (!rec) {
    const d = store.draftSides();
    return { left: d.left, right: d.right, outcome: null };
  }
  return { left: rec.left, right: rec.right, outcome: rec.outcome };
}

/* ---------------- 渲染：关卡 ---------------- */

function renderLevelTabs(): void {
  const wrap = $('#levelTabs');
  wrap.innerHTML = LEVELS.map((lv, i) => `
    <button class="level-tab ${i === store.state.levelIndex ? 'active' : ''}"
      data-act="select-level" data-i="${i}" data-testid="level-tab-${i}">
      <span class="lt-name">${esc(lv.name)}
        <span class="badge-tag ${i === 1 ? 'tag-combo' : i === 2 ? 'tag-tight' : ''}">${esc(lv.tag)}</span>
      </span>
      <span class="lt-desc">${esc(lv.highlight)} · ${lv.packageCount} 个包裹 · ${lv.maxWeighings} 次称量机会 · 候选 ${lv.candidates.join('/')} kg</span>
    </button>`).join('');

  const lv = store.level;
  $('#levelName').textContent = lv.name;
  const tag = $('#levelTag');
  tag.textContent = lv.tag;
  tag.className = `badge-tag ${store.state.levelIndex === 1 ? 'tag-combo' : store.state.levelIndex === 2 ? 'tag-tight' : ''}`;
  $('#levelBrief').textContent = lv.brief;
  $('#hintList').innerHTML = lv.hints.map((h) => `<li>${esc(h)}</li>`).join('');
}

/* ---------------- 渲染：次数 / 天平状态 ---------------- */

function renderHud(): void {
  const s = store.state;
  const left = store.attemptsLeft();
  const max = store.level.maxWeighings;
  const bar = $('#attemptsBar');
  bar.classList.toggle('exhausted', left === 0);
  bar.innerHTML = `
    <span>称量次数</span>
    <span class="pips" data-testid="attempt-pips">
      ${Array.from({ length: max }, (_, i) => `<span class="pip ${i < s.records.length ? 'used' : ''}"></span>`).join('')}
    </span>
    <span class="attempt-num" data-testid="attempts-left">剩余 ${left} / ${max} 次</span>`;

  const cap = $('#scaleCaption');
  if (s.viewing === 'draft') {
    cap.textContent = '正在摆放：当前摆法（未确认）';
  } else {
    cap.textContent = `翻查：第 ${s.viewing + 1} 次确认称量（共 ${s.records.length} 条记录）`;
  }

  const line = $('#outcomeLine');
  const view = currentScaleView();
  if (view.outcome === null) {
    line.innerHTML = `<span class="outcome-draft">未确认摆法不产生结果 · 两盘放好后点击「确认称量」</span>`;
  } else {
    line.innerHTML = `<span class="result-badge ${outcomeClass(view.outcome)}" style="font-size:15.5px;padding:5px 20px">
      ${view.outcome === 1 ? '← 左盘更重' : view.outcome === -1 ? '右盘更重 →' : '天平平衡'}
    </span>`;
  }

  const check = store.canConfirm();
  const btn = $<HTMLButtonElement>('#confirmBtn');
  btn.disabled = !check.ok;
  btn.textContent = s.won
    ? '已通关'
    : left === 0
      ? '称量次数已用完'
      : `确认称量 · 消耗 1 次 · 当前余 ${left} 次`;
  $('#confirmReason').textContent = check.ok ? '' : (check.reason ?? '');
}

/* ---------------- 渲染：摆法行 ---------------- */

function renderTrayRows(): void {
  const n = store.level.packageCount;
  const tray = store.state.tray;
  const wrap = $('#trayRows');
  wrap.innerHTML = Array.from({ length: n }, (_, p) => {
    const cur = tray[p];
    const btn = (slot: 'left' | 'right' | null, label: string, testid: string) => `
      <button data-act="set-tray" data-p="${p}" data-slot="${slot ?? 'none'}"
        data-focus-key="tray-${p}-${slot ?? 'none'}"
        data-testid="${testid}"
        aria-pressed="${cur === slot}">${label}</button>`;
    return `
      <div class="tray-row" data-testid="tray-row-${p}">
        <span class="pkg-badge">${p + 1}</span>
        <span class="tray-name">包裹 ${p + 1}</span>
        <span class="seg seg-tray">
          ${btn('left', '放左盘', `tray-${p}-left`)}
          ${btn('right', '放右盘', `tray-${p}-right`)}
          ${btn(null, '取下', `tray-${p}-none`)}
        </span>
        <span class="muted small">当前：${cur === 'left' ? '左盘' : cur === 'right' ? '右盘' : '未上秤'}</span>
      </div>`;
  }).join('');
}

/* ---------------- 渲染：历史记录 ---------------- */

function miniPkgs(ids: number[]): string {
  return ids.map((i) => `<span class="mini-pkg">${i + 1}</span>`).join('');
}

function renderHistory(): void {
  const el = $('#historyList');
  const recs = store.state.records;
  if (recs.length === 0) {
    el.innerHTML = `<div class="history-empty" data-testid="history-empty">还没有确认过称量。摆好两盘后点「确认称量」，结果与摆法会永久保留在这里，可随时点击翻查。</div>`;
    return;
  }
  el.innerHTML = recs.map((r, i) => `
    <button class="history-item ${store.state.viewing === i ? 'selected' : ''}"
      data-act="view" data-i="${i}" data-testid="history-${i}">
      <span class="hi-top">
        <span class="hi-index">第 ${i + 1} 次称量</span>
        <span class="result-badge ${outcomeClass(r.outcome)}">${esc(outcomeLabel(r.outcome))}</span>
      </span>
      <span class="hi-body">
        <span class="hi-side">${miniPkgs(r.left)}</span>
        <span class="hi-op">${r.outcome === 0 ? '=' : r.outcome === 1 ? '＞' : '＜'}</span>
        <span class="hi-side">${miniPkgs(r.right)}</span>
      </span>
    </button>`).join('')
    + `<button class="history-item ${store.state.viewing === 'draft' ? 'selected' : ''}"
        data-act="view" data-i="draft" data-testid="history-draft">
        <span class="hi-top"><span class="hi-index">＋ 当前摆法 / 新称量</span></span>
        <span class="hi-body"><span class="muted small">点击回到摆秤界面</span></span>
      </button>`;
}

/* ---------------- 渲染：可能性 ---------------- */

function renderPossibilities(): void {
  const panel = $('#possibilityPanel');
  const lv = store.level;
  const survivors = store.survivors();
  const poss = store.possibilities();
  const exhausted = store.attemptsLeft() === 0;

  const summaryCls = survivors.length === 1 ? 'poss-summary'
    : exhausted && survivors.length > 1 ? 'poss-summary exhaust'
    : 'poss-summary';
  const summaryText = survivors.length === 1
    ? `✓ 全部 ${store.state.records.length} 条记录联合后，只剩 1 种完整重量组合——每个包裹的重量都已锁定。`
    : exhausted && survivors.length > 1
      ? `⏱ 次数已用尽，但仍有 ${survivors.length} 种完整重量组合与全部 ${store.state.records.length} 条记录相容，局面尚未确定。可继续提交分组检验，或重新开始。`
      : `目前有 ${survivors.length} 种完整重量组合，能同时通过全部 ${store.state.records.length} 条称量记录。`;

  const rows = poss.map((pp) => `
    <div class="pkg-poss-row" data-testid="poss-row-${pp.packageId}">
      <span class="poss-label">包裹 ${pp.packageId + 1}</span>
      <span class="cand-chips">
        ${lv.candidates.map((w) => {
          const alive = pp.possible.includes(w);
          const support = pp.supportCount.get(w) ?? 0;
          return `<span class="cand ${alive ? 'alive' : 'dead'}" data-testid="cand-${pp.packageId}-${w}">
            ${w} kg${alive && survivors.length > 1 ? `<span class="support">${support} 种组合</span>` : ''}
          </span>`;
        }).join('')}
      </span>
    </div>`).join('');

  const listRows = survivors.map((a, idx) => `
    <div class="assign-row" data-testid="assign-row-${idx}">
      ${a.map((w, p) => `<span class="aw" title="包裹 ${p + 1}"><b>${p + 1}#</b>${w}</span>`).join('')}
    </div>`).join('');

  panel.innerHTML = `
    <div class="${summaryCls}" data-testid="survivor-count" data-count="${survivors.length}">${esc(summaryText)}</div>
    ${rows}
    <details class="assign-details" open>
      <summary>翻查所有仍成立的完整重量组合（${survivors.length}，可滚动）</summary>
      <div class="assign-list" data-testid="assign-list">${listRows}</div>
    </details>`;
}

/* ---------------- 渲染：货架分组 ---------------- */

function shelfRanges(survivors: readonly (readonly number[])[]): { A: [number, number]; B: [number, number] } {
  const { A, B } = store.shelfSides();
  const range = (ids: number[]): [number, number] => {
    if (ids.length === 0 || survivors.length === 0) return [0, 0];
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of survivors) {
      const v = sumOf(a, ids);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return [lo, hi];
  };
  return { A: range(A), B: range(B) };
}

function renderShelf(): void {
  const n = store.level.packageCount;
  const shelf = store.state.shelf;
  const { A, B } = store.shelfSides();
  const survivors = store.survivors();
  const ranges = shelfRanges(survivors);
  const complete = store.shelfComplete();

  const zone = (slot: 'A' | 'B', ids: number[], title: string, range: [number, number]): string => `
    <div class="shelf-zone zone-${slot}" data-testid="zone-${slot}">
      <h4><span>${title}</span>
        <span class="shelf-total-range">${ids.length === 0 ? '空' : `可能总重 ${range[0]}–${range[1]} kg`}</span>
      </h4>
      <div class="shelf-chips">
        ${ids.length ? ids.map((p) => `<span class="mini-pkg" data-act="set-shelf" data-p="${p}" data-slot="${slot}"
            style="cursor:pointer" title="点击移回未分配">${p + 1}</span>`).join('')
          : '<span class="shelf-empty">点击下方包裹放入</span>'}
      </div>
    </div>`;

  const assigned = A.length + B.length;
  const unassigned = n - assigned;

  const rows = Array.from({ length: n }, (_, p) => {
    const cur = shelf[p];
    const locked = store.state.won ? 'disabled' : '';
    const btn = (slot: 'A' | 'B' | null, label: string, testid: string) => `
      <button data-act="set-shelf" data-p="${p}" data-slot="${slot ?? 'none'}" ${locked}
        data-focus-key="shelf-${p}-${slot ?? 'none'}"
        data-testid="${testid}" aria-pressed="${cur === slot}">${label}</button>`;
    return `
      <div class="shelf-row" data-testid="shelf-row-${p}">
        <span class="pkg-badge">${p + 1}</span>
        <span class="tray-name">包裹 ${p + 1}</span>
        <span class="seg seg-shelf">
          ${btn('A', '→ 左架', `shelf-${p}-A`)}
          ${btn('B', '→ 右架', `shelf-${p}-B`)}
          ${btn(null, '未分', `shelf-${p}-none`)}
        </span>
      </div>`;
  }).join('');

  $('#shelfPanel').innerHTML = `
    <div class="shelf-zones">
      ${zone('A', A, '左货架', ranges.A)}
      ${zone('B', B, '右货架', ranges.B)}
    </div>
    <div class="unassigned" data-testid="shelf-progress">
      ${complete ? `✓ ${n} 个包裹已全部分配` : `还有 ${unassigned} 个包裹未分配（已分配 ${assigned}/${n}），全部放好后才能提交`}
    </div>
    <div class="shelf-rows">${rows}</div>`;

  const submit = $<HTMLButtonElement>('#submitBtn');
  submit.disabled = !complete || store.state.won;
  submit.textContent = store.state.won
    ? '本组划分已证明必然等重 ✓'
    : complete ? '提交分组，检验必然性' : `还有 ${unassigned} 个包裹未分配`;
}

/* ---------------- 渲染：判定 + 反例 ---------------- */

function witnessTable(w: readonly number[], shelf: readonly (string | null)[]): string {
  return `
    <table class="witness-table">
      <tr>${w.map((_, p) => `<th class="on-${shelf[p] ?? ''}">包裹${p + 1}</th>`).join('')}</tr>
      <tr>${w.map((weight) => `<td><span class="w">${weight}</span></td>`).join('')}</tr>
    </table>`;
}

function sumsLine(w: readonly number[]): string {
  const { A, B } = store.shelfSides();
  const ls = sumOf(w, A);
  const rs = sumOf(w, B);
  const expr = (ids: number[]) => ids.map((p) => w[p]).join('+') || '0';
  const dir = ls === rs ? '相等' : ls > rs ? '左架更重' : '右架更重';
  return `<div class="witness-sums">左架 ${expr(A)} = ${ls} kg　vs　右架 ${expr(B)} = ${rs} kg　→　${dir}</div>`;
}

function renderVerdict(): void {
  const el = $('#verdictPanel');
  const v = store.state.verdict;
  if (!v || store.state.verdictSignature !== store.shelfSignature()) {
    el.innerHTML = '';
    return;
  }
  const recordCount = store.state.records.length;

  if (v.kind === 'necessary-equal') {
    const sumText = v.possibleEqualSums.length === 1
      ? `两架总重都为 <b>${v.possibleEqualSums[0]} kg</b>`
      : `共同总重可能是 ${v.possibleEqualSums.join('、')} kg（随剩余可能变化），但在每一种可能下两架都相等`;
    const truth = store.level.trueWeights;
    el.innerHTML = `
      <div class="verdict-box verdict-ok" data-testid="verdict" data-kind="necessary-equal">
        <h4>🎉 必然等重，分组成立！</h4>
        <p>枚举全部 <b>${v.survivorCount}</b> 种剩余可能，没有任何一种能让两架不等——${sumText}。</p>
        <p class="truth-reveal">🔎 真相揭晓：各包裹真实重量为
          ${truth.map((w, p) => `<span class="mini-pkg" title="包裹${p + 1}">${p + 1}# ${w}kg</span>`).join('　')}
        </p>
        <div class="win-actions">
          <button class="btn btn-primary" data-act="restart" data-testid="restart-win">↻ 重玩本关（次数与记录还原）</button>
          <button class="btn" data-act="next-level" data-testid="next-level">下一关 →</button>
        </div>
      </div>`;
    return;
  }

  if (v.kind === 'contingent-equal') {
    el.innerHTML = `
      <div class="verdict-box verdict-warn" data-testid="verdict" data-kind="contingent-equal">
        <h4>⚠ 还不能提交：只是「碰巧」会相等</h4>
        <p>你的分组在<b>某些</b>剩余可能下确实等重（见下），但并非在全部 ${v.survivorCount} 种可能下都成立。
           下面这组<b>反例</b>与全部 ${recordCount} 条称量记录同时相容，两架却不等重：</p>
        <div class="witness" data-testid="counterexample">
          <div class="witness-title">🔻 反例重量分配（必然检验未通过）</div>
          ${witnessTable(v.counterexample, store.state.shelf)}
          ${sumsLine(v.counterexample)}
        </div>
        <details class="assign-details">
          <summary>存在一组让它碰巧相等的可能（对照）</summary>
          <div class="witness">
            ${witnessTable(v.equalExample, store.state.shelf)}
            ${sumsLine(v.equalExample)}
          </div>
        </details>
        <p class="small" style="margin-bottom:0">提示：继续称量以排除反例，或点右上角「重新开始」还原次数与记录。</p>
      </div>`;
    return;
  }

  if (v.kind === 'never-equal') {
    el.innerHTML = `
      <div class="verdict-box verdict-bad" data-testid="verdict" data-kind="never-equal">
        <h4>✗ 这组划分不可能公平</h4>
        <p>在当前全部 ${v.survivorCount} 种剩余可能下，两架都不会相等。例如下面这组与全部 ${recordCount} 条记录相容的重量：</p>
        <div class="witness" data-testid="counterexample">
          <div class="witness-title">🔻 反例重量分配</div>
          ${witnessTable(v.counterexample, store.state.shelf)}
          ${sumsLine(v.counterexample)}
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="verdict-box verdict-bad" data-testid="verdict" data-kind="no-possibility">
      <h4>记录之间出现矛盾，已无可能重量</h4>
      <p>这在公正游戏中不应发生（真实重量始终满足记录）。请重新开始。</p>
    </div>`;
}

/* ---------------- 总渲染 ---------------- */

function renderAll(): void {
  renderLevelTabs();
  renderHud();
  renderTrayRows();
  renderHistory();
  renderPossibilities();
  renderShelf();
  renderVerdict();
  renderer.setView(currentScaleView());
}

store.subscribe(() => renderAll());

/* ---------------- 事件代理 ---------------- */

document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset.focusKey ?? null;

  switch (act) {
    case 'select-level': {
      const i = Number(target.dataset.i);
      store.selectLevel(i);
      break;
    }
    case 'restart':
      store.restart();
      break;
    case 'next-level':
      store.selectLevel((store.state.levelIndex + 1) % LEVELS.length);
      break;
    case 'set-tray': {
      const p = Number(target.dataset.p);
      const slot = target.dataset.slot === 'left' ? 'left' : target.dataset.slot === 'right' ? 'right' : null;
      store.setTray(p, slot);
      break;
    }
    case 'clear-tray':
      store.clearTray();
      break;
    case 'confirm':
      store.confirmWeighing();
      break;
    case 'view': {
      const raw = target.dataset.i;
      store.viewRecord(raw === 'draft' ? 'draft' : Number(raw));
      break;
    }
    case 'set-shelf': {
      const p = Number(target.dataset.p);
      const slot = target.dataset.slot === 'A' ? 'A' : target.dataset.slot === 'B' ? 'B' : null;
      // 点货架区里的包裹 chip（带当前 slot）时，同一 slot 表示移回未分配
      if (target.classList.contains('mini-pkg') && store.state.shelf[p] === slot) {
        store.setShelf(p, null);
      } else {
        store.setShelf(p, slot);
      }
      break;
    }
    case 'submit':
      store.submitPartition();
      // 判定后滚动到结果（小屏友好）
      requestAnimationFrame(() => {
        $('#verdictPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      break;
  }

  if (focusKey) {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`);
      el?.focus({ preventScroll: true });
    });
  }
});

// 首次渲染
renderAll();

// 暴露给无头自测 / 控制台检查
declare global {
  interface Window {
    __game?: { store: GameStore; verdict?: PartitionVerdict | null };
  }
}
window.__game = { store };
