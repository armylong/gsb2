import type { Arrangement, Beat, Puzzle } from '../core/model';
import { expandArrangement } from '../core/sequencer';
import { judge, type JudgeResult } from '../core/judge';
import { PUZZLES } from '../core/puzzles';
import { DrumKit } from './audio';

const W = 960;
const H = 620;
const SLOT_Y = 12;
const SLOT_H = 60;
const SLOT_W = 122;
const SLOT_GAP = 10;
const SLOT_X = 16;
const PLAYER_TAPE_Y = 116;
const TARGET_TAPE_Y = 300;
const TAPE_X0 = 92;
const ROW_H = 34;
const PAD_Y = 470;
const PAD_H = 90;

interface PlayState {
  gen: number;
  beats: Beat[];
  which: 'player' | 'target';
  start: number;
  interval: number;
  lastBeat: number;
}

export function startApp(): void {
  const canvas = document.getElementById('cv') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.scale(dpr, dpr);

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const statusEl = $<HTMLDivElement>('status');
  const hintEl = $<HTMLDivElement>('hint');
  const descEl = $<HTMLDivElement>('desc');
  const puzzleSel = $<HTMLSelectElement>('puzzle');
  const speedEl = $<HTMLInputElement>('speed');
  const speedLabel = $<HTMLSpanElement>('speed-label');

  const kit = new DrumKit();

  // —— 状态 ——
  let puzzle: Puzzle = PUZZLES[0];
  let arrangement: Arrangement = [];
  let undoStack: Arrangement[] = [];
  let selected: number | null = null;
  let judgeResult: JudgeResult | null = null;
  let playGen = 0;
  let play: PlayState | null = null;
  let stepIdx: number | null = null;
  let flashes: { track: number; until: number }[] = [];
  let drag: { index: number; x: number; moved: boolean } | null = null;

  const stripMap = () => new Map(puzzle.strips.map((s) => [s.id, s]));
  const tracks = () => puzzle.trackNames.length;
  const saveKey = () => `mbp:${puzzle.id}`;

  function loadPuzzle(p: Puzzle): void {
    puzzle = p;
    stopPlayback();
    undoStack = [];
    selected = null;
    hintEl.textContent = '';
    const saved = localStorage.getItem(saveKey());
    arrangement = saved ? (JSON.parse(saved) as Arrangement) : structuredClone(p.initial);
    descEl.textContent = `${p.title} —— ${p.description}`;
    refreshJudge();
  }

  function persist(): void {
    localStorage.setItem(saveKey(), JSON.stringify(arrangement));
  }

  function stopPlayback(): void {
    playGen++;
    kit.silenceAll();
    play = null;
    stepIdx = null;
  }

  /** 所有摆法变更都走这里：先停旧声音，再留撤销快照，最后重算判定 */
  function mutate(fn: (a: Arrangement) => void): void {
    stopPlayback();
    undoStack.push(structuredClone(arrangement));
    fn(arrangement);
    persist();
    refreshJudge();
  }

  function refreshJudge(): void {
    judgeResult = judge(puzzle, arrangement);
    renderStatus();
  }

  function renderStatus(): void {
    if (!judgeResult) return;
    const lines: string[] = [];
    if (judgeResult.pass) {
      lines.push('✔ 通关！鼓点和空拍全部对上，用纸限制也都满足。');
    } else {
      for (const v of judgeResult.violations) lines.push(`✘ 用纸限制：${v}`);
      if (judgeResult.beatDetail) {
        lines.push(
          `✘ 第 1 处偏差在第 ${(judgeResult.firstBadBeat ?? 0) + 1} 拍：${judgeResult.beatDetail}`,
        );
      }
    }
    statusEl.textContent = lines.join('\n');
    statusEl.className = judgeResult.pass ? 'pass' : 'fail';
  }

  // —— 播放 ——
  function startPlayback(beats: Beat[], which: 'player' | 'target'): void {
    stopPlayback();
    const gen = playGen;
    const interval = 60 / Number(speedEl.value);
    const start = kit.now() + 0.12;
    beats.forEach((b, i) => {
      b.hits.forEach((h, t) => {
        if (h) kit.hit(t, start + i * interval, gen);
      });
    });
    play = { gen, beats, which, start, interval, lastBeat: -1 };
  }

  function playMine(): void {
    const exp = expandArrangement(arrangement, stripMap(), tracks());
    if (!exp.ok) {
      judgeResult = {
        pass: false,
        violations: [],
        expandError: exp.reason,
        firstBadBeat: exp.beatIndex,
        beatDetail: exp.reason,
      };
      renderStatus();
      return;
    }
    startPlayback(exp.beats, 'player');
  }

  function stepOnce(): void {
    stopPlayback();
    const exp = expandArrangement(arrangement, stripMap(), tracks());
    if (!exp.ok || exp.beats.length === 0) return;
    if (stepIdx === null || stepIdx >= exp.beats.length) stepIdx = 0;
    const beat = exp.beats[stepIdx];
    const now = kit.now();
    beat.hits.forEach((h, t) => {
      if (h) kit.hit(t, now, playGen);
    });
    beat.hits.forEach((h, t) => {
      if (h) flashes.push({ track: t, until: performance.now() + 220 });
    });
    stepIdx++;
  }

  // —— 画布几何 ——
  function tapeGeom(beatCount: number): { x0: number; colW: number } {
    const colW = Math.min(36, (W - TAPE_X0 - 16) / Math.max(beatCount, 1));
    return { x0: TAPE_X0, colW };
  }

  function slotAt(x: number, y: number): number | null {
    if (y < SLOT_Y || y > SLOT_Y + SLOT_H) return null;
    for (let i = 0; i < arrangement.length; i++) {
      const sx = SLOT_X + i * (SLOT_W + SLOT_GAP);
      if (x >= sx && x <= sx + SLOT_W) return i;
    }
    return null;
  }

  // —— 绘制 ——
  function draw(): void {
    ctx.clearRect(0, 0, W, H);
    ctx.font = '13px system-ui, sans-serif';
    drawSlots();
    const exp = expandArrangement(arrangement, stripMap(), tracks());
    drawTape(exp.beats, PLAYER_TAPE_Y, '我的摆法', 'player', exp.ok ? null : exp.beatIndex);
    drawTape(puzzle.target, TARGET_TAPE_Y, '目标节奏', 'target', null);
    drawPads();
    requestAnimationFrame(draw);
  }

  function drawSlots(): void {
    ctx.fillStyle = '#888';
    ctx.fillText('读卡槽（拖动换序 · 双击倒向 · 点击选中）', SLOT_X, 8);
    arrangement.forEach((e, i) => {
      const x = SLOT_X + i * (SLOT_W + SLOT_GAP);
      const isSel = selected === i;
      ctx.fillStyle = e.kind === 'return' ? '#3a2f5a' : '#2b3a55';
      ctx.strokeStyle = isSel ? '#ffd166' : '#556';
      ctx.lineWidth = isSel ? 2.5 : 1;
      roundRect(x, SLOT_Y, SLOT_W, SLOT_H, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#eee';
      if (e.kind === 'strip') {
        const def = stripMap().get(e.stripId);
        ctx.fillText(`${def?.name ?? e.stripId} ${e.reversed ? '← 倒向' : '→ 正向'}`, x + 10, SLOT_Y + 24);
        ctx.fillStyle = '#9ab';
        ctx.fillText('双击可倒向', x + 10, SLOT_Y + 44);
      } else {
        ctx.fillText(`↩ 返回标记`, x + 10, SLOT_Y + 24);
        ctx.fillStyle = '#9ab';
        ctx.fillText(`回到第 ${e.backTo + 1} 槽`, x + 10, SLOT_Y + 44);
      }
    });
    if (drag && drag.moved) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      roundRect(drag.x - SLOT_W / 2, SLOT_Y, SLOT_W, SLOT_H, 8);
      ctx.fill();
    }
  }

  function drawTape(
    beats: Beat[],
    y: number,
    label: string,
    which: 'player' | 'target',
    stopAt: number | null,
  ): void {
    const { x0, colW } = tapeGeom(Math.max(beats.length, puzzle.maxBeats));
    ctx.fillStyle = '#888';
    ctx.fillText(label, 16, y - 6);
    puzzle.trackNames.forEach((name, t) => {
      ctx.fillStyle = '#9ab';
      ctx.fillText(name, 16, y + t * ROW_H + ROW_H / 2 + 4);
    });
    // 当前播放位置
    let playBeat: number | null = null;
    if (play && play.which === which) {
      const pos = (kit.now() - play.start) / play.interval;
      if (pos >= 0 && pos < beats.length) playBeat = Math.floor(pos);
    }
    if (which === 'player' && stepIdx !== null && stepIdx > 0) playBeat = stepIdx - 1;

    beats.forEach((b, i) => {
      const x = x0 + i * colW;
      // 空拍也画一格，让停顿在画面上看得出来
      ctx.fillStyle = i % 2 ? '#1c2230' : '#212839';
      ctx.fillRect(x, y, colW - 1, ROW_H * tracks());
      if (playBeat === i) {
        ctx.fillStyle = 'rgba(255, 209, 102, 0.18)';
        ctx.fillRect(x, y, colW - 1, ROW_H * tracks());
        ctx.strokeStyle = '#ffd166';
        ctx.strokeRect(x + 0.5, y + 0.5, colW - 2, ROW_H * tracks() - 1);
      }
      b.hits.forEach((h, t) => {
        if (!h) return;
        const cx = x + colW / 2;
        const cy = y + t * ROW_H + ROW_H / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(9, colW / 2 - 3), 0, Math.PI * 2);
        ctx.fillStyle = which === 'target' ? '#7d8590' : ['#ff6b6b', '#4ecdc4', '#c084fc'][t];
        ctx.fill();
      });
      if (stopAt !== null && i === stopAt) {
        ctx.strokeStyle = '#ff9f1c';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, colW - 3, ROW_H * tracks() - 2);
        ctx.lineWidth = 1;
      }
    });
    // 判定标出的第一处问题拍
    if (which === 'player' && judgeResult && judgeResult.firstBadBeat !== undefined && !judgeResult.pass) {
      const i = judgeResult.firstBadBeat;
      if (i < beats.length + 1) {
        const x = x0 + Math.min(i, beats.length) * colW;
        ctx.strokeStyle = '#ff3b30';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 1, y + 1, colW - 3, ROW_H * tracks() - 2);
        ctx.lineWidth = 1;
      }
    }
  }

  function drawPads(): void {
    const now = performance.now();
    flashes = flashes.filter((f) => f.until > now);
    const padW = 180;
    puzzle.trackNames.forEach((name, t) => {
      const x = 16 + t * (padW + 16);
      const lit = flashes.some((f) => f.track === t);
      ctx.fillStyle = lit ? ['#ff6b6b', '#4ecdc4', '#c084fc'][t] : '#2b3a55';
      roundRect(x, PAD_Y, padW, PAD_H, 10);
      ctx.fill();
      ctx.fillStyle = lit ? '#111' : '#9ab';
      ctx.fillText(name, x + 14, PAD_Y + 28);
    });
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  // —— 播放推进（视觉） ——
  function tick(): void {
    if (play) {
      const pos = (kit.now() - play.start) / play.interval;
      const cur = Math.floor(pos);
      if (cur > play.lastBeat) {
        for (let b = Math.max(0, play.lastBeat + 1); b <= cur && b < play.beats.length; b++) {
          play.beats[b].hits.forEach((h, t) => {
            if (h) flashes.push({ track: t, until: performance.now() + 220 });
          });
        }
        play.lastBeat = cur;
      }
      if (pos >= play.beats.length) play = null;
    }
    requestAnimationFrame(tick);
  }

  // —— 鼠标交互 ——
  function canvasPos(ev: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  canvas.addEventListener('mousedown', (ev) => {
    const { x, y } = canvasPos(ev);
    const i = slotAt(x, y);
    if (i !== null) drag = { index: i, x, moved: false };
  });

  canvas.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const { x } = canvasPos(ev);
    if (Math.abs(x - drag.x) > 6) drag.moved = true;
    drag.x = x;
  });

  canvas.addEventListener('mouseup', (ev) => {
    if (!drag) return;
    const { x, y } = canvasPos(ev);
    const from = drag.index;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) {
      const to = slotAt(x, y);
      if (to !== null && to !== from) {
        mutate((a) => {
          const [e] = a.splice(from, 1);
          a.splice(to, 0, e);
        });
        selected = to;
      }
    } else {
      selected = from;
    }
    updateMarkerButtons();
  });

  canvas.addEventListener('dblclick', (ev) => {
    const { x, y } = canvasPos(ev);
    const i = slotAt(x, y);
    if (i === null) return;
    const e = arrangement[i];
    if (e.kind === 'strip') {
      mutate(() => {
        e.reversed = !e.reversed;
      });
    }
  });

  // —— 控件 ——
  function updateMarkerButtons(): void {
    const e = selected !== null ? arrangement[selected] : null;
    const isMarker = e?.kind === 'return';
    ($<HTMLButtonElement>('marker-dec')).disabled = !isMarker;
    ($<HTMLButtonElement>('marker-inc')).disabled = !isMarker;
    ($<HTMLButtonElement>('marker-del')).disabled = !isMarker;
    const used = arrangement.filter((x) => x.kind === 'return').length;
    ($<HTMLButtonElement>('marker-add')).disabled = used >= puzzle.returnTokens;
  }

  $('play').addEventListener('click', playMine);
  $('play-target').addEventListener('click', () => startPlayback(puzzle.target, 'target'));
  $('step').addEventListener('click', stepOnce);
  $('stop').addEventListener('click', stopPlayback);
  speedEl.addEventListener('input', () => {
    speedLabel.textContent = `${speedEl.value} BPM`;
  });

  $('undo').addEventListener('click', () => {
    const prev = undoStack.pop();
    if (!prev) return;
    stopPlayback();
    arrangement = prev;
    persist();
    refreshJudge();
  });

  $('hint').addEventListener('click', () => {
    hintEl.textContent = `提示：${puzzle.hint}`;
  });

  $('reset').addEventListener('click', () => {
    localStorage.removeItem(saveKey());
    loadPuzzle(puzzle);
  });

  $('marker-add').addEventListener('click', () => {
    mutate((a) => a.push({ kind: 'return', backTo: 0 }));
    selected = arrangement.length - 1;
    updateMarkerButtons();
  });

  $('marker-dec').addEventListener('click', () => {
    if (selected === null) return;
    const e = arrangement[selected];
    if (e.kind !== 'return') return;
    mutate(() => {
      e.backTo = Math.max(0, e.backTo - 1);
    });
  });

  $('marker-inc').addEventListener('click', () => {
    if (selected === null) return;
    const e = arrangement[selected];
    if (e.kind !== 'return') return;
    mutate(() => {
      e.backTo = Math.min(arrangement.length - 1, e.backTo + 1);
    });
  });

  $('marker-del').addEventListener('click', () => {
    if (selected === null) return;
    if (arrangement[selected].kind !== 'return') return;
    mutate((a) => {
      a.splice(selected!, 1);
    });
    selected = null;
    updateMarkerButtons();
  });

  puzzleSel.addEventListener('change', () => {
    const p = PUZZLES.find((x) => x.id === puzzleSel.value);
    if (p) loadPuzzle(p);
    updateMarkerButtons();
  });

  for (const p of PUZZLES) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.title;
    puzzleSel.appendChild(opt);
  }

  loadPuzzle(PUZZLES[0]);
  updateMarkerButtons();
  requestAnimationFrame(draw);
  requestAnimationFrame(tick);
}
