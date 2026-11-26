import './style.css';
import { runChecks } from './game/checks';
import { filterLabel, simulate, stepState } from './game/engine';
import { eaveAt, phaseAt, roundAt } from './game/geometry';
import { LEVELS } from './game/levels';
import { renderStage, scopeAtPoint, STAGE_H, STAGE_W } from './ui/renderer';
import type { Command, FilterId, GameState, LossEvent, ScopeId } from './game/types';

const $ = <T extends HTMLElement = HTMLElement>(idOrSelector: string): T => {
  const el =
    idOrSelector.startsWith('#') || idOrSelector.startsWith('[') || idOrSelector.startsWith('.')
      ? document.querySelector(idOrSelector)
      : document.getElementById(idOrSelector);
  if (!el) throw new Error(`Missing element ${idOrSelector}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');

let levelIndex = 0;
let level = LEVELS[levelIndex];
let commands: (Command | null)[] = commandsForLevel(level);
let playhead = 0;
let selectedScope: ScopeId = 0;
let speed = 1;
let playing = false;
let timer: number | null = null;
let reason: { kind: 'idle' | 'error' | 'success'; text: string } = {
  kind: 'idle',
  text: '选择一台镜子和动作；每次有效动作会推进一拍。也可以直接播放预排脚本。',
};

function commandsForLevel(target: (typeof LEVELS)[number]): (Command | null)[] {
  return Array.from({ length: target.totalBeats }, (_, i) =>
    target.script[i] ? structuredClone(target.script[i]!) : null,
  );
}

function currentResult() {
  return simulate(level, commands);
}

function pausePlayback(): void {
  playing = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function startPlayback(): void {
  pausePlayback();
  playing = true;
  const interval = 820 / speed;
  timer = window.setInterval(() => {
    if (playhead < level.totalBeats) {
      playhead += 1;
      renderAll();
    } else {
      pausePlayback();
      renderAll();
    }
  }, interval);
}

function setReason(text: string, kind: 'idle' | 'error' | 'success' = 'idle'): void {
  reason = { text, kind };
  const box = $('actionReason');
  box.textContent = text;
  box.className = `action-reason ${kind === 'idle' ? '' : kind}`;
}

function seek(next: number): void {
  playhead = Math.max(0, Math.min(level.totalBeats, next));
}

function selectLevel(index: number, autoplay: boolean): void {
  pausePlayback();
  levelIndex = index;
  level = LEVELS[index]!;
  commands = commandsForLevel(level);
  playhead = 0;
  selectedScope = 0;
  speed = 1;
  ($('speedSelect') as HTMLSelectElement).value = '1';
  setReason(
    level.demo
      ? '短演示已载入：按播放查看走台冲突、窗口交界、屋檐遮拍和滤片提前量。'
      : '已载入内置参考动作；可直接播放，或点“重来”清空后制定自己的打法。',
  );
  renderLevelTabs();
  renderAll();
  if (autoplay) {
    playhead = 0;
    startPlayback();
    renderAll();
  }
}

function renderLevelTabs(): void {
  const tabs = $('levelTabs');
  tabs.innerHTML = '';
  LEVELS.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `level-tab${item.demo ? ' demo' : ''}${i === levelIndex ? ' active' : ''}`;
    btn.textContent = item.name;
    btn.addEventListener('click', () => selectLevel(i, Boolean(item.demo)));
    tabs.appendChild(btn);
  });
  $('levelTagline').textContent = level.tagline;
  $('levelBrief').innerHTML =
    level.brief.map((p) => `<p>${p}</p>`).join('') +
    (level.dayBeats > 0
      ? '<p class="muted">固定回合中白昼拍不能累计观测，但适合转向、换滤片或搬镜；昼夜不读取本机时间。</p>'
      : '');
}

function commandIcon(command: Command | null): string {
  if (!command || command.type === 'idle') return '·';
  if (command.type === 'rotate') return command.dir === -1 ? '↶' : '↷';
  if (command.type === 'filter') return command.filter === 'red' ? '红片' : command.filter === 'blue' ? '蓝片' : '白光';
  if (command.type === 'start') return '◎';
  if (command.type === 'stop') return '■';
  if (command.type === 'move') return command.dir === -1 ? '←搬' : '搬→';
  return '·';
}

function renderTransport(result: ReturnType<typeof currentResult>): void {
  const playBtn = $<HTMLButtonElement>('playBtn');
  playBtn.textContent = playing ? '⏸ 暂停' : playhead >= level.totalBeats ? '↻ 重新播放' : '▶ 播放';
  playBtn.classList.toggle('playing', playing);
  $<HTMLButtonElement>('stepBtn').disabled = playhead >= level.totalBeats;
  $<HTMLButtonElement>('backBtn').disabled = playhead <= 0;

  const nextBeat = Math.min(playhead, level.totalBeats - 1);
  const phase = phaseAt(level, nextBeat);
  const round = roundAt(level, nextBeat);
  $('phasePill').innerHTML = `第 ${round} 固定回合 · <span class="beat-phase ${phase}">${phase === 'day' ? '白昼' : '黑夜'}</span>`;
  $('playStatePill').textContent = playing
    ? `播放中 ${speed}× · 结果由纯引擎预计算，快进不改结果`
    : playhead >= level.totalBeats
      ? '播放结束：点损失条目可回到该拍'
      : '';
  $('playheadLabel').textContent = `视角：第 ${playhead} 拍后 / 共 ${level.totalBeats} 拍；下一动作拍：${
    playhead < level.totalBeats ? playhead + 1 : '已结束'
  }`;
  void result;
}

function renderTimeline(result: ReturnType<typeof currentResult>): void {
  const timeline = $('timeline');
  timeline.innerHTML = '';
  for (let beat = 0; beat < level.totalBeats; beat += 1) {
    const report = result.reports[beat]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    const hasLoss = result.losses.some((l) => l.beat === beat);
    const hasRecord = result.records.some((r) => r.endBeat === beat);
    btn.className = [
      'beat',
      beat < playhead ? 'past' : '',
      beat === playhead && playhead < level.totalBeats ? 'edit' : '',
      playhead === beat + 1 ? 'inspected' : '',
      hasLoss ? 'has-loss' : '',
      hasRecord ? 'has-record' : '',
    ]
      .filter(Boolean)
      .join(' ');
    btn.title = [
      `第 ${beat + 1} 拍 · ${report.phase === 'day' ? '昼' : '夜'}`,
      report.command ? `动作：${describeCommand(report.command)}` : '空过/继续既有观测',
      report.rejection ? `冲突：${report.rejection}` : '',
      ...report.ticks.filter((t) => !t.credited).map((t) => t.message),
    ]
      .filter(Boolean)
      .join('\n');

    const phase = document.createElement('span');
    phase.className = `beat-phase ${report.phase}`;
    phase.textContent = report.phase === 'day' ? '昼' : '夜';
    const num = document.createElement('span');
    num.className = 'beat-num';
    num.textContent = `${beat + 1}`;
    const icon = document.createElement('span');
    icon.className = 'cmd-icon';
    icon.textContent = commandIcon(commands[beat] ?? null);
    btn.append(phase, num, icon);
    btn.addEventListener('click', () => {
      pausePlayback();
      seek(beat + 1);
      renderAll();
    });
    timeline.appendChild(btn);
  }
}

function cellLabel(cell: GameState['scopes'][number]['cell']): string {
  if (cell === 'w0') return `A 窗位 · ${level.windows[0]!.name}`;
  if (cell === 'w1') return `B 窗位 · ${level.windows[1]!.name}`;
  return '共用走台（未到位）';
}

function renderScopePanel(state: GameState): void {
  const tabs = $('scopeTabs');
  tabs.innerHTML = '';
  level.scopes.forEach((def) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `scope-tab${selectedScope === def.id ? ' active' : ''}`;
    btn.dataset.scope = String(def.id);
    btn.textContent = def.short;
    btn.title = def.name;
    btn.addEventListener('click', () => {
      selectedScope = def.id;
      renderAll();
    });
    tabs.appendChild(btn);
  });

  const s = state.scopes[selectedScope]!;
  const target = s.targetId ? level.bodies.find((b) => b.id === s.targetId) : null;
  $('scopeStatus').innerHTML = `
    <div class="status-chip">位置<b>${cellLabel(s.cell)}</b></div>
    <div class="status-chip">朝向<b>${s.heading.toFixed(1)}° · 转速 ${level.scopes[selectedScope].slew}°/拍</b></div>
    <div class="status-chip">滤片<b>${filterLabel(s.filter)}</b></div>
    <div class="status-chip">观测<b>${
      s.observing && target ? `${target.name} · ${s.streak}/${target.requiredBeats} 连` : '未在观测'
    }</b></div>
  `;

  const prevBtn = $<HTMLButtonElement>('[data-action="move-prev"]');
  const nextBtn = $<HTMLButtonElement>('[data-action="move-next"]');
  const idx = s.cell === 'w0' ? 0 : s.cell === 'walk' ? 1 : 2;
  prevBtn.textContent = idx === 1 ? '← 退回 A 窗' : idx === 2 ? '← 搬入走台' : '← A 方向已到头';
  nextBtn.textContent = idx === 0 ? '搬入走台 →' : idx === 1 ? '搬出到 B 窗 →' : 'B 方向已到头 →';
  prevBtn.disabled = idx === 0 || playhead >= level.totalBeats;
  nextBtn.disabled = idx === 2 || playhead >= level.totalBeats;

  document.querySelectorAll<HTMLButtonElement>('.filter[data-filter]').forEach((btn) => {
    const f = btn.dataset.filter as FilterId;
    btn.classList.toggle('active-clear', s.filter === 'clear' && f === 'clear');
    btn.classList.toggle('active-red', s.filter === 'red' && f === 'red');
    btn.classList.toggle('active-blue', s.filter === 'blue' && f === 'blue');
    btn.disabled = playhead >= level.totalBeats;
  });
  document.querySelectorAll<HTMLButtonElement>('.action-grid .action').forEach((btn) => {
    if (btn.dataset.action !== 'move-prev' && btn.dataset.action !== 'move-next') {
      btn.disabled = playhead >= level.totalBeats;
    }
  });
}

function describeCommand(command: Command): string {
  if (command.type === 'rotate') return `${level.scopes[command.scopeId ?? 0]?.name ?? ''}${command.dir === -1 ? '左转' : '右转'}`;
  if (command.type === 'filter') return `切${filterLabel(command.filter ?? 'clear')}`;
  if (command.type === 'start') return `${level.scopes[command.scopeId ?? 0]?.name ?? ''}开始观测`;
  if (command.type === 'stop') return '停止观测';
  if (command.type === 'move') return `${level.scopes[command.scopeId ?? 0]?.name ?? ''}搬镜 ${command.dir === -1 ? '向 A' : '向 B'}`;
  return '空过';
}

function renderForecast(result: ReturnType<typeof currentResult>): void {
  const host = $('forecast');
  const upcomingRuns = result.runs
    .filter((run) => run.endBeat >= Math.max(0, playhead - 2))
    .slice(0, 5);

  const runHtml = upcomingRuns
    .map((run) => {
      const body = level.bodies.find((b) => b.id === run.bodyId)!;
      const win = level.windows[run.windowIndex]!;
      return `
        <div class="run-card">
          <strong><span style="color:${body.color}">${body.name}</span><span>${win.short}窗 ${run.startBeat + 1}–${run.endBeat + 1}拍</span></strong>
          <div class="tag-row">
            <span class="tag night">${run.beats} 拍过窗</span>
            ${run.eaveBeats.map((b) => `<span class="tag eave">檐遮第${b + 1}拍</span>`).join('')}
            ${run.dayBeats.slice(0, 3).map((b) => `<span class="tag day">昼第${b + 1}拍</span>`).join('')}
          </div>
        </div>`;
    })
    .join('');

  const rows: string[] = [];
  const forecastStart = Math.min(playhead, level.totalBeats - 1);
  const last = Math.min(level.totalBeats - 1, forecastStart + 5);
  for (let beat = forecastStart; beat <= last; beat += 1) {
    const after = result.states[beat + 1]!;
    const phase = phaseAt(level, beat);
    const bodies = level.bodies
      .map((def) => {
        const bs = after.bodies.find((b) => b.id === def.id)!;
        let cls = 'mini-body out';
        let text = '场外';
        level.windows.forEach((win, wi) => {
          const rel = ((bs.angle - win.centre + 540) % 360) - 180;
          if (Math.abs(rel) <= win.halfWidth) {
            if (eaveAt(bs.angle, win.centre, win.eave)) {
              cls = 'mini-body blocked';
              text = `${wi === 0 ? 'A' : 'B'}窗·檐遮`;
            } else {
              cls = 'mini-body';
              text = `${wi === 0 ? 'A' : 'B'}窗可见`;
            }
          }
        });
        return `<span class="${cls}">${def.color === '#fff' ? '★' : '●'} ${def.name.split('（')[0]}：${text} ${bs.angle.toFixed(0)}°</span>`;
      })
      .join('');
    const headings = after.scopes
      .map((s) => `<span class="mini-body">${s.id === 0 ? '①' : '②'} ${s.heading.toFixed(0)}°${s.observing ? ' ◎' : ''}${s.cell === 'walk' ? ' 走台' : ''}</span>`)
      .join('');
    rows.push(`
      <tr>
        <td><b>${beat + 1}</b><br><span class="beat-phase ${phase}">${phase === 'day' ? '昼' : '夜'}</span></td>
        <td>${bodies}</td>
        <td>${headings}</td>
      </tr>`);
  }

  host.innerHTML = `
    ${runHtml || '<div class="empty">附近没有新的可见段。</div>'}
    <table class="forecast-table">
      <thead><tr><th>拍</th><th>下一小段窗口</th><th>结算后镜头朝向</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  `;
}

function renderRecords(state: GameState): void {
  const host = $('records');
  const required = level.bodies.filter((b) => b.designated).length;
  const uniqueTargets = new Set(state.records.map((r) => r.targetId)).size;
  if (!state.records.length) {
    host.innerHTML = `<div class="empty">尚无合格记录。目标：${uniqueTargets}/${required} 种已交。</div>`;
    return;
  }
  host.innerHTML =
    `<div class="loss-summary">已交目标 ${uniqueTargets}/${required}；记录不会因后续檐遮或换片被删除。</div>` +
    state.records
      .map(
        (r) => `
        <div class="record-card">
          <b>${r.targetName}</b><br>
          ${r.scopeName} · 第 ${r.startBeat + 1}–${r.endBeat + 1} 拍连续 ${r.beats} 拍 · ${filterLabel(r.filter)}
        </div>`,
      )
      .join('');
}

const KIND_LABEL: Record<LossEvent['kind'], string> = {
  conflict: '动作冲突',
  interruption: '连续中断',
  missed: '本拍损失',
  'window-miss': '窗口错过',
};

function renderLosses(result: ReturnType<typeof currentResult>): void {
  const host = $('losses');
  const summary = $('lossSummary');
  const settledLosses = result.losses.filter((l) => l.beat < playhead);
  const counts = settledLosses.reduce<Record<string, number>>((acc, l) => {
    acc[l.kind] = (acc[l.kind] ?? 0) + 1;
    return acc;
  }, {});
  summary.textContent = settledLosses.length
    ? `已结算 ${playhead}/${level.totalBeats} 拍：冲突 ${counts.conflict ?? 0}，中断 ${counts.interruption ?? 0}，未中 ${counts.missed ?? 0}，窗口错过 ${counts['window-miss'] ?? 0}。点击条目回到该拍。`
    : playhead < level.totalBeats
      ? '已结算拍还没有损失。继续单步或播放；右侧窗口卡会提前标出檐遮/白昼拍。'
      : '目前没有损失或冲突。';

  if (!settledLosses.length) {
    host.innerHTML = '<div class="empty">播放后，这里会指出具体哪一拍损失了观测。</div>';
    return;
  }

  host.innerHTML = '';
  [...settledLosses]
    .sort((a, b) => a.beat - b.beat)
    .forEach((loss) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `loss-item ${loss.kind}`;
      btn.innerHTML = `<span class="loss-beat">第${loss.beat + 1}拍 · ${KIND_LABEL[loss.kind]}</span>${loss.message}`;
      btn.addEventListener('click', () => {
        pausePlayback();
        seek(loss.beat + 1);
        renderAll();
      });
      host.appendChild(btn);
    });
}

function drawStage(result: ReturnType<typeof currentResult>): void {
  if (!ctx) return;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const state = result.states[playhead]!;
  const report = playhead > 0 ? result.reports[playhead - 1]! : null;
  renderStage(ctx, { level, state, result, playhead, selectedScope, report });
}

function renderAll(): void {
  const result = currentResult();
  renderTransport(result);
  renderTimeline(result);
  renderScopePanel(result.states[playhead]!);
  renderForecast(result);
  renderRecords(result.states[playhead]!);
  renderLosses(result);
  drawStage(result);
  const reasonBox = $('actionReason');
  reasonBox.textContent = reason.text;
  reasonBox.className = `action-reason ${reason.kind === 'idle' ? '' : reason.kind}`;
}

function commitCommand(command: Command): void {
  pausePlayback();
  if (playhead >= level.totalBeats) {
    setReason('本关已经走完。可以点“上一拍”复查/改写，或点“重来”。', 'error');
    renderAll();
    return;
  }

  const probe = stepState(level, currentResult().states[playhead]!, command, playhead);
  if (!probe.accepted) {
    setReason(probe.rejection ?? '这两个动作当前冲突。', 'error');
    renderAll();
    return;
  }

  commands[playhead] = { ...command };
  seek(playhead + 1);
  selectedScope = command.scopeId ?? selectedScope;

  const scopeTick =
    command.scopeId === undefined
      ? probe.ticks.find((t) => !t.credited) ?? probe.ticks[0]
      : probe.ticks.find((t) => t.scopeId === command.scopeId);
  const interruption =
    command.scopeId === undefined
      ? probe.losses[0]
      : probe.losses.find((l) => l.scopeId === command.scopeId);
  if (scopeTick && !scopeTick.credited) {
    setReason(`第 ${probe.beat + 1} 拍动作已执行，但观测损失：${scopeTick.message}`, 'error');
  } else if (interruption) {
    setReason(`第 ${probe.beat + 1} 拍：${interruption.message}`, 'error');
  } else if (scopeTick?.credited) {
    setReason(`第 ${probe.beat + 1} 拍有效：${scopeTick.message}`, 'success');
  } else {
    setReason(`第 ${probe.beat + 1} 拍已安排：${describeCommand(command)}。`, 'success');
  }
  renderAll();
}

// Event wiring
$('playBtn').addEventListener('click', () => {
  if (playing) {
    pausePlayback();
    renderAll();
    return;
  }
  if (playhead >= level.totalBeats) playhead = 0;
  startPlayback();
  renderAll();
});

$('stepBtn').addEventListener('click', () => {
  pausePlayback();
  if (playhead < level.totalBeats) seek(playhead + 1);
  renderAll();
});

$('backBtn').addEventListener('click', () => {
  pausePlayback();
  seek(playhead - 1);
  setReason('已回到上一拍。此时选择动作会覆盖该拍命令，后续命令保留并重新结算。', 'idle');
  renderAll();
});

$('resetBtn').addEventListener('click', () => {
  pausePlayback();
  commands = new Array(level.totalBeats).fill(null);
  playhead = 0;
  setReason('已重来：所有自排动作清空，天象回到第 1 拍之前；昼夜仍按固定回合走。', 'idle');
  renderAll();
});

$('loadScriptBtn').addEventListener('click', () => {
  selectLevel(levelIndex, true);
});

$<HTMLSelectElement>('speedSelect').addEventListener('change', (e) => {
  speed = Number((e.target as HTMLSelectElement).value);
  if (playing) startPlayback();
});

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action === 'rotate-left') commitCommand({ type: 'rotate', scopeId: selectedScope, dir: -1 });
    if (action === 'rotate-right') commitCommand({ type: 'rotate', scopeId: selectedScope, dir: 1 });
    if (action === 'start') commitCommand({ type: 'start', scopeId: selectedScope });
    if (action === 'stop') commitCommand({ type: 'stop', scopeId: selectedScope });
    if (action === 'move-prev') commitCommand({ type: 'move', scopeId: selectedScope, dir: -1 });
    if (action === 'move-next') commitCommand({ type: 'move', scopeId: selectedScope, dir: 1 });
    if (action === 'idle') commitCommand({ type: 'idle' });
  });
});

document.querySelectorAll<HTMLButtonElement>('.filter[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter as FilterId;
    commitCommand({ type: 'filter', scopeId: selectedScope, filter });
  });
});

canvas.addEventListener('click', (event: MouseEvent) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * STAGE_W;
  const y = ((event.clientY - rect.top) / rect.height) * STAGE_H;
  const id = scopeAtPoint(level, currentResult().states[playhead]!, x, y);
  if (id !== null) {
    selectedScope = id;
    renderAll();
  }
});

$('selfcheckBtn').addEventListener('click', () => {
  const results = runChecks();
  const host = $('checkResults');
  host.innerHTML = results
    .map(
      (r) => `
      <div class="check-row ${r.ok ? 'pass' : 'fail'}">
        <strong>${r.ok ? '✓' : '×'} ${r.name}</strong>
        <span>${r.detail}</span>
      </div>`,
    )
    .join('');
  $('checkModal').classList.remove('hidden');
});

$('closeChecks').addEventListener('click', () => $('checkModal').classList.add('hidden'));
$('checkModal').addEventListener('click', (e) => {
  if (e.target === $('checkModal')) $('checkModal').classList.add('hidden');
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('playBtn').click();
  } else if (e.key === 'ArrowRight') {
    $('stepBtn').click();
  } else if (e.key === 'ArrowLeft') {
    $('backBtn').click();
  } else if (e.key.toLowerCase() === 'r') {
    $('resetBtn').click();
  } else if (e.key === '1' || e.key === '2') {
    selectedScope = (Number(e.key) - 1) as ScopeId;
    renderAll();
  }
});

renderLevelTabs();
selectLevel(0, false);
