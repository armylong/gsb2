import './styles.css';

import {
  COLORS,
  Dir,
  FaceSlot,
  GameState,
  ORI_SLOTS,
  Progress,
  evaluate,
  faceColor,
  initialState,
  parseLevel,
  tryMove,
  tryStamp,
} from './game/engine';
import { LEVELS, getLevel } from './game/levels';
import { HintResult, buildHint } from './game/solver';
import {
  FrameData,
  SaveData,
  formatSavedAt,
  loadActiveSave,
  loadSlot,
  saveSlot,
  slotId,
} from './game/storage';
import { BumpAnim, Flash, FloatText, Renderer, RollAnim } from './ui/render';

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少 DOM 元素 #${id}`);
  return el as T;
}

interface LogLine {
  text: string;
  kind: '' | 'good' | 'bad' | 'sys';
}

class GameApp {
  private canvas = must<HTMLCanvasElement>('game-canvas');
  private renderer: Renderer;

  private tabsEl = must('level-tabs');
  private nameEl = must('level-name');
  private subtitleEl = must('level-subtitle');
  private briefEl = must('level-brief');
  private variantBox = must<HTMLElement>('variant-box');
  private variantList = must('variant-list');
  private variantNote = must('variant-note');

  private poseGrid = must('pose-grid');
  private stampPreview = must('stamp-preview');
  private btnStamp = must<HTMLButtonElement>('btn-stamp');

  private btnUndo = must<HTMLButtonElement>('btn-undo');
  private btnRedo = must<HTMLButtonElement>('btn-redo');
  private btnHint = must<HTMLButtonElement>('btn-hint');
  private btnReset = must<HTMLButtonElement>('btn-reset');
  private ruleBlocks = must<HTMLInputElement>('rule-blocks');

  private progressCount = must('progress-count');
  private progressList = must('progress-list');
  private sealStatus = must('seal-status');

  private hintText = must('hint-text');
  private hintActions = must('hint-actions');

  private logList = must('log-list');
  private saveStatus = must('save-status');
  private btnSave = must<HTMLButtonElement>('btn-save');

  private winOverlay = must<HTMLElement>('win-overlay');
  private winDetail = must('win-detail');
  private btnWinReplay = must<HTMLButtonElement>('btn-win-replay');
  private btnWinNext = must<HTMLButtonElement>('btn-win-next');

  // ---- 当前局状态 ----
  private level = LEVELS[0];
  private board = parseLevel(LEVELS[0]);
  private variantId: string | null = null;
  private blocks = LEVELS[0].stampedBlocks;
  private frames: FrameData[] = [];
  private index = 0;
  private progress!: Progress;
  private hint: HintResult | null = null;

  // ---- 动效 ----
  private roll: RollAnim | null = null;
  private bump: BumpAnim | null = null;
  private flashes: Flash[] = [];
  private floats: FloatText[] = [];
  private busyUntil = 0;
  private winTimer: number | null = null;
  private hintAutoTimer: number | null = null;

  private logs: LogLine[] = [];
  private restoredSavedAt: number | null = null;

  constructor() {
    this.renderer = new Renderer(this.canvas);
    this.restoreOrFresh();
    this.bindEvents();
    this.renderLevelChrome();
    this.buildTabs();
    this.refresh();
    this.persist();
    if (this.restoredSavedAt) {
      this.saveStatus.textContent = `已恢复 ${formatSavedAt(this.restoredSavedAt)} 的存档，改动会自动保存`;
    }
    this.addLog('方向键 / WASD 滚动，空格盖印；点 💡提示 可从当前局面找下一步。', 'sys');

    requestAnimationFrame(() => this.renderer.fit(this.board.cols, this.board.rows));
    const ro = new ResizeObserver(() => this.renderer.fit(this.board.cols, this.board.rows));
    ro.observe(must('canvas-wrap'));

    requestAnimationFrame(this.loop);
  }

  // ============================================================
  // 初始化 / 存档恢复
  // ============================================================
  private restoreOrFresh() {
    const saved = loadActiveSave();
    if (saved && LEVELS.some((l) => l.id === saved.levelId)) {
      this.applySave(saved);
      this.restoredSavedAt = saved.savedAt;
      this.addLog('已恢复上次棋局：印记与撤销栈都保持在关闭前的状态。', 'sys');
      if (saved.savedAt) this.saveStatus.textContent = `已恢复 ${formatSavedAt(saved.savedAt)} 的局`;
    } else {
      this.level = LEVELS[0];
      this.board = parseLevel(this.level);
      this.variantId = this.level.variants?.[0]?.id ?? null;
      this.blocks = this.level.stampedBlocks;
      this.frames = this.freshFrames();
      this.index = 0;
    }
  }

  private applySave(saved: SaveData) {
    this.level = getLevel(saved.levelId);
    this.board = parseLevel(this.level);
    this.blocks = saved.stampedBlocks;
    this.frames = saved.frames;
    this.index = saved.index;
    if (this.level.variants?.length) {
      const byId = saved.variantId ? this.level.variants.find((v) => v.id === saved.variantId) : undefined;
      if (byId) {
        this.variantId = byId.id;
      } else {
        const ori = this.frames[0]?.state.ori;
        this.variantId = this.level.variants.find((v) => v.ori === ori)?.id ?? this.level.variants[0].id;
      }
    } else {
      this.variantId = null;
    }
  }

  private freshFrames(): FrameData[] {
    const ori = this.currentOri();
    return [{ kind: 'init', state: initialState(this.board, ori) }];
  }

  private currentOri(): string | undefined {
    if (!this.variantId || !this.level.variants) return this.level.startOri;
    return this.level.variants.find((v) => v.id === this.variantId)?.ori ?? this.level.startOri;
  }

  private get present(): GameState {
    return this.frames[this.index].state;
  }

  private persist() {
    const data = saveSlot({
      levelId: this.level.id,
      variantId: this.variantId,
      stampedBlocks: this.blocks,
      frames: this.frames,
      index: this.index,
    });
    this.saveStatus.textContent = `已自动保存 ${formatSavedAt(data.savedAt)}`;
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  private bindEvents() {
    // 方向键按钮
    document.querySelectorAll<HTMLButtonElement>('.dbtn[data-dir]').forEach((btn) => {
      btn.addEventListener('click', () => this.doMove(btn.dataset.dir as Dir));
    });

    this.btnStamp.addEventListener('click', () => this.doStamp());
    this.btnUndo.addEventListener('click', () => this.undo());
    this.btnRedo.addEventListener('click', () => this.redo());
    this.btnReset.addEventListener('click', () => this.resetLevel());
    this.btnHint.addEventListener('click', () => this.requestHint());
    this.btnSave.addEventListener('click', () => {
      this.persist();
      this.saveStatus.textContent = `已保存到本地 ${formatSavedAt(Date.now())}`;
      this.addLog('当前棋局（含全部撤销帧）已保存。', 'sys');
    });

    this.ruleBlocks.addEventListener('change', () => {
      this.blocks = this.ruleBlocks.checked;
      this.setHint(null);
      this.refresh();
      this.persist();
      this.addLog(this.blocks ? '规则已开启：盖印格不能再次进入。' : '规则已关闭：盖印格仍可通行（提示会按当前规则搜索）。', 'sys');
    });

    this.btnWinReplay.addEventListener('click', () => this.doReset());
    this.btnWinNext.addEventListener('click', () => {
      const i = LEVELS.findIndex((l) => l.id === this.level.id);
      this.selectLevel(LEVELS[(i + 1) % LEVELS.length].id);
    });

    // 画布点击：点相邻格 = 滚过去；点自己 = 提示用空格盖印
    this.canvas.addEventListener('click', (e) => {
      const cell = this.renderer.pick(e.clientX, e.clientY);
      if (!cell || performance.now() < this.busyUntil) return;
      const dx = cell.x - this.present.x;
      const dy = cell.y - this.present.y;
      if (Math.abs(dx) + Math.abs(dy) !== 1) {
        if (dx === 0 && dy === 0) {
          this.addFloat(this.present.x, this.present.y, '空格 / 按钮盖印', '#ffe6a8');
        }
        return;
      }
      const dir: Dir = dx === 1 ? 'E' : dx === -1 ? 'W' : dy === 1 ? 'S' : 'N';
      this.doMove(dir);
    });

    // 鼠标 / 触摸点过按钮后立即移除焦点，避免之后按 Space 同时触发
    // 全局“盖印”和该按钮的原生 Space 点击（键盘 Tab 聚焦时仍可用 Space/Enter 点按）。
    document.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement | null)?.closest?.('button');
      if (b && typeof b.blur === 'function') b.blur();
    });

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
      if (typing) return; // 复选框等控件保留原生按键行为

      // 焦点正好在按钮上时，Space/Enter 交给原生 click，避免与全局盖印重复
      if (key === ' ' && tag === 'BUTTON') return;

      const map: Record<string, Dir> = {
        arrowup: 'N',
        arrowdown: 'S',
        arrowleft: 'W',
        arrowright: 'E',
        w: 'N',
        s: 'S',
        a: 'W',
        d: 'E',
      };
      if (key.startsWith('arrow') || key === ' ') e.preventDefault();
      if (e.repeat) return;

      if (map[key]) {
        this.doMove(map[key]);
      } else if (key === ' ') {
        this.doStamp();
      } else if (key === 'z' && !(e.ctrlKey || e.metaKey)) {
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (key === 'y' || ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'z')) {
        e.preventDefault();
        this.redo();
      } else if (key === 'h') {
        this.requestHint();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persist();
    });
    window.addEventListener('beforeunload', () => this.persist());
  }

  // ============================================================
  // 关卡 / 朝向切换
  // ============================================================
  private buildTabs() {
    this.tabsEl.innerHTML = '';
    LEVELS.forEach((lv, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'level-tab' + (lv.id === this.level.id ? ' active' : '');
      b.textContent = `${i + 1}. ${lv.name}`;
      b.addEventListener('click', () => this.selectLevel(lv.id));
      this.tabsEl.appendChild(b);
    });
  }

  private selectLevel(id: string) {
    if (id === this.level.id) return;
    this.persist(); // 离开前存好当前槽
    const lv = getLevel(id);
    this.level = lv;
    const preferredVariant = lv.variants?.[0]?.id ?? null;
    const existing = loadSlot(slotId(lv.id, preferredVariant));
    if (existing) {
      this.applySave(existing);
      this.addLog(`已切到「${lv.name}」并恢复该关存档。`, 'sys');
    } else {
      this.board = parseLevel(lv);
      this.variantId = preferredVariant;
      this.blocks = lv.stampedBlocks;
      this.frames = this.freshFrames();
      this.index = 0;
      this.addLog(`已切换到「${lv.name}」。`, 'sys');
    }
    this.afterLevelChanged();
  }

  private selectVariant(vid: string) {
    if (vid === this.variantId) return;
    this.persist();
    const existing = loadSlot(slotId(this.level.id, vid));
    this.variantId = vid;
    if (existing) {
      this.applySave(existing);
      this.addLog('已恢复该朝向的存档。', 'sys');
    } else {
      this.blocks = this.level.stampedBlocks;
      this.frames = this.freshFrames();
      this.index = 0;
      this.addLog('已按新的起点朝向重开一局——同样的纸面，不同的走向。', 'sys');
    }
    this.afterLevelChanged();
  }

  private afterLevelChanged() {
    this.cancelAutoHint();
    this.hint = null;
    this.roll = null;
    this.bump = null;
    this.flashes = [];
    this.floats = [];
    this.hideWin();
    this.buildTabs();
    this.renderLevelChrome();
    this.setHint(null);
    this.refresh();
    this.persist();
    requestAnimationFrame(() => this.renderer.fit(this.board.cols, this.board.rows));
  }

  private renderLevelChrome() {
    this.nameEl.textContent = this.level.name;
    this.subtitleEl.textContent = this.level.subtitle;
    this.briefEl.textContent = this.level.brief;

    if (this.level.variants?.length) {
      this.variantBox.hidden = false;
      this.variantList.innerHTML = '';
      this.level.variants.forEach((v) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'variant-btn' + (v.id === this.variantId ? ' active' : '');
        b.textContent = v.label;
        b.addEventListener('click', () => this.selectVariant(v.id));
        this.variantList.appendChild(b);
      });
      const v = this.level.variants.find((x) => x.id === this.variantId);
      this.variantNote.textContent = (v?.note ?? '') + (this.level.forkNote ? '  ' + this.level.forkNote : '');
    } else {
      this.variantBox.hidden = true;
    }
  }

  // ============================================================
  // 动作
  // ============================================================
  private doMove(dir: Dir) {
    const now = performance.now();
    if (now < this.busyUntil || this.progress.won) return;

    const from = this.present;
    const res = tryMove(from, this.board, dir, this.blocks);
    if (!res.ok) {
      this.busyUntil = now + 200;
      this.bump = { x: from.x, y: from.y, dir, start: now, dur: 260 };
      this.flashes.push({ x: res.tx, y: res.ty, reason: res.reason, start: now, dur: 560 });
      if (res.reason === 'wall') {
        this.addFloat(res.tx, res.ty, '墙挡住了', '#d7deff');
      } else {
        this.addFloat(res.tx, res.ty, '印未干·不能进入', '#ffb3a8');
        this.addLog('走不通：那是刚盖的印（不是墙）。可绕路或撤销盖印。', 'bad');
      }
      return;
    }

    this.commit(res.state, 'move', dir);
    this.roll = {
      fx: from.x,
      fy: from.y,
      tx: res.tx,
      ty: res.ty,
      dir,
      oriFrom: from.ori,
      start: now,
      dur: 190,
    };
    this.busyUntil = now + 190;
    this.setHint(null);
    this.refresh();
    this.persist();
  }

  private doStamp() {
    const now = performance.now();
    if (now < this.busyUntil || this.progress.won) return;

    const res = tryStamp(this.present, this.board);
    if (!res.ok) {
      if (res.reason === 'occupied') {
        this.addFloat(this.present.x, this.present.y, '此格已有印', '#ffe0a3');
        this.addLog('此格已经盖过印；要改色请先撤销。', 'bad');
      } else {
        this.addFloat(this.present.x, this.present.y, '封口格要最后盖', '#ffb3a8');
        this.addLog('封口格尚未解锁：先把所有普通目标格盖对。', 'bad');
      }
      return;
    }

    this.commit(res.state, 'stamp');
    const name = COLORS[res.color].name;
    if (res.verdict === 'right') {
      this.addFloat(this.present.x, this.present.y, `盖对·${name}`, '#8df0b6');
      this.addLog(`盖上「${name}」，颜色正确。`, 'good');
    } else if (res.verdict === 'wrong-color') {
      this.addFloat(this.present.x, this.present.y, `错色·${name}`, '#ff9d92');
      this.addLog(`盖上「${name}」，但本格要求另一种颜色——撤销这一步即可。`, 'bad');
    } else if (res.verdict === 'clean-blot') {
      this.addFloat(this.present.x, this.present.y, '素格不能留色', '#ff9d92');
      this.addLog('这是素格：可以走过，但不能留色。撤销盖印即可清除。', 'bad');
    } else {
      this.addFloat(this.present.x, this.present.y, '这里不需盖印', '#ffd166');
      this.addLog('普通地板上的印属于污渍，会阻碍通关，建议撤销。', 'bad');
    }

    this.setHint(null);
    this.refresh();
    this.persist();

    if (this.progress.won) {
      if (this.winTimer) window.clearTimeout(this.winTimer);
      this.winTimer = window.setTimeout(() => this.showWin(), 700);
    }
  }

  private commit(state: GameState, kind: 'move' | 'stamp', dir?: Dir) {
    // 撤销后若采取新动作，旧的 redo 分支被丢弃
    this.frames = this.frames.slice(0, this.index + 1);
    this.frames.push({ state, kind, dir });
    this.index = this.frames.length - 1;
  }

  private undo() {
    if (this.index <= 0 || performance.now() < this.busyUntil) return;
    this.index -= 1;
    this.afterHistoryNavigation('已撤销一步，纸面与朝向回到上一帧。');
  }

  private redo() {
    if (this.index >= this.frames.length - 1 || performance.now() < this.busyUntil) return;
    this.index += 1;
    this.afterHistoryNavigation('已重做一步。');
  }

  private afterHistoryNavigation(log: string) {
    this.cancelAutoHint();
    this.roll = null;
    this.bump = null;
    this.hideWin();
    this.setHint(null);
    this.refresh();
    this.persist();
    this.addLog(log, 'sys');
  }

  private resetLevel() {
    const acted = this.index > 0;
    if (acted && !window.confirm('确定清空当前路线与印记，从该起手朝向的初始局面重来吗？')) return;
    this.doReset();
  }

  private doReset() {
    this.cancelAutoHint();
    if (this.winTimer) window.clearTimeout(this.winTimer);
    this.frames = this.freshFrames();
    this.index = 0;
    this.hint = null;
    this.roll = null;
    this.bump = null;
    this.flashes = [];
    this.floats = [];
    this.hideWin();
    this.setHint(null);
    this.refresh();
    this.persist();
    this.addLog('已重置为初始局面。', 'sys');
  }

  // ============================================================
  // 提示
  // ============================================================
  private requestHint() {
    if (this.progress.won) {
      this.setHint({ kind: 'won', text: '这一局已经完成，无需提示。' });
      return;
    }
    const predecessors = this.frames.slice(0, this.index).map((f) => f.state);
    const hint = buildHint(this.board, predecessors, this.present, this.blocks, this.progress.won);
    this.setHint(hint);
  }

  private executeHintAction(action: Extract<HintResult, { kind: 'next' }>['action']) {
    if (action.type === 'move') this.doMove(action.dir);
    else this.doStamp();
    // 连续引导：动作/翻滚结束后，自动从新姿态再算一条提示
    if (this.hintAutoTimer) window.clearTimeout(this.hintAutoTimer);
    this.hintAutoTimer = window.setTimeout(
      () => this.requestHint(),
      action.type === 'move' ? 210 : 60,
    );
  }

  private cancelAutoHint() {
    if (this.hintAutoTimer !== null) {
      window.clearTimeout(this.hintAutoTimer);
      this.hintAutoTimer = null;
    }
  }

  private jumpBackAndHint(steps: number) {
    this.cancelAutoHint();
    this.index = Math.max(0, this.index - steps);
    this.roll = null;
    this.bump = null;
    this.hideWin();
    this.refresh();
    this.persist();
    this.addLog(`按提示连续回退 ${steps} 步。`, 'sys');
    this.requestHint();
  }

  private setHint(h: HintResult | null) {
    this.hint = h;
    // 清掉控件脉冲
    this.btnStamp.classList.remove('hint-pulse');
    this.btnHint.classList.remove('hint-pulse');
    document.querySelectorAll('.dbtn').forEach((b) => b.classList.remove('hint-pulse'));

    if (!h) {
      this.hintText.textContent =
        '点「提示」会从当前姿态与纸面出发，实时搜一条可行的下一步；若已无解，则提示退回几步。';
      this.hintActions.innerHTML = '';
      return;
    }

    this.hintText.textContent = h.text;
    this.hintActions.innerHTML = '';

    if (h.kind === 'next') {
      const action = h.action;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn primary';
      b.textContent = '执行这一步';
      b.addEventListener('click', () => this.executeHintAction(action));
      this.hintActions.appendChild(b);

      if (action.type === 'stamp') {
        this.btnStamp.classList.add('hint-pulse');
      } else {
        const sel = `.dbtn[data-dir="${action.dir}"]`;
        document.querySelector(sel)?.classList.add('hint-pulse');
      }
    } else if (h.kind === 'undo') {
      const steps = h.undoSteps;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn accent';
      b.textContent = `回退 ${steps} 步并继续提示`;
      b.addEventListener('click', () => this.jumpBackAndHint(steps));
      this.hintActions.appendChild(b);
      this.btnUndo.classList.add('hint-pulse');
    }
  }

  // ============================================================
  // HUD
  // ============================================================
  private refresh() {
    this.progress = evaluate(this.board, this.present);
    this.ruleBlocks.checked = this.blocks;
    this.renderPose();
    this.renderProgress();
    this.renderHistoryButtons();
  }

  private renderPose() {
    const ori = this.present.ori;
    this.poseGrid.innerHTML = '';
    const names: Record<FaceSlot, string> = { T: '顶面', B: '贴地', N: '北侧', S: '南侧', E: '东侧', W: '西侧' };
    for (const slot of ORI_SLOTS) {
      const info = COLORS[faceColor(ori, slot)];
      const cell = document.createElement('div');
      cell.className = 'pose-cell' + (slot === 'B' ? ' bottom' : '');
      const label = document.createElement('span');
      label.className = 'slot-name';
      label.textContent = names[slot];
      const chip = document.createElement('span');
      chip.className = 'pose-chip';
      chip.style.background = info.hex;
      chip.style.color = info.ink;
      chip.textContent = info.name;
      cell.append(label, chip);
      this.poseGrid.appendChild(cell);
    }
    const bottom = COLORS[faceColor(ori, 'B')];
    this.stampPreview.style.background = bottom.hex;
    this.stampPreview.style.color = bottom.ink;
    this.stampPreview.style.borderColor = bottom.deep;
    this.stampPreview.textContent = bottom.name;
  }

  private renderProgress() {
    const p = this.progress;
    this.progressCount.textContent = `${p.rightCount}/${p.total}`;
    this.progressList.innerHTML = '';
    for (const s of p.slots) {
      const need = COLORS[s.need];
      const li = document.createElement('li');
      li.className = `progress-item ${s.kind}`;
      li.title = this.board.slotCells[s.index]?.def.note ?? '';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = need.hex;
      dot.textContent = need.name;

      const main = document.createElement('span');
      const coord = document.createElement('span');
      coord.textContent = `目标 ${s.index + 1} `;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = `(${s.x},${s.y})`;
      main.append(coord, where);
      if (s.seal) {
        const flag = document.createElement('span');
        flag.className = 'seal-flag';
        flag.textContent = '封口';
        flag.style.marginLeft = '6px';
        main.appendChild(flag);
      }

      const state = document.createElement('span');
      state.className = 'state';
      if (s.kind === 'right') state.textContent = '✓ 正确';
      else if (s.kind === 'wrong') state.textContent = `✕ 已成${s.got ? COLORS[s.got].name : '?'}`;
      else state.textContent = '未盖';

      li.append(dot, main, state);
      this.progressList.appendChild(li);
    }

    if (p.sealTotal > 0) {
      this.sealStatus.style.display = '';
      if (p.sealsReady) {
        this.sealStatus.className = 'seal-status ready';
        this.sealStatus.textContent = `普通目标 ${p.normalRight}/${p.normalTotal} 已全部正确——封口格解锁，请最后盖下。`;
      } else {
        this.sealStatus.className = 'seal-status locked';
        this.sealStatus.textContent = `封口格未解锁：先正确盖完普通目标（${p.normalRight}/${p.normalTotal}）。`;
      }
    } else {
      this.sealStatus.style.display = 'none';
      this.sealStatus.textContent = '';
    }
  }

  private renderHistoryButtons() {
    this.btnUndo.disabled = this.index <= 0;
    this.btnRedo.disabled = this.index >= this.frames.length - 1;
  }

  // ============================================================
  // 胜利浮层
  // ============================================================
  private showWin() {
    const used = this.frames.slice(1, this.index + 1);
    const moves = used.filter((f) => f.kind === 'move').length;
    const stamps = used.filter((f) => f.kind === 'stamp').length;
    let ending = '';
    if (this.level.fork) {
      const v = this.level.variants?.find((x) => x.id === this.variantId);
      ending = `\n${v?.label ?? ''}：最后停在 (${this.present.x},${this.present.y}) 的封口格。换一种起手朝向，结局会不同。`;
    }
    this.winDetail.textContent = `滚动 ${moves} 次 · 盖印 ${stamps} 次，所有要求都已满足。${ending}`;
    this.winOverlay.hidden = false;
  }

  private hideWin() {
    this.winOverlay.hidden = true;
  }

  // ============================================================
  // 日志 / 漂浮字
  // ============================================================
  private addLog(text: string, kind: LogLine['kind'] = '') {
    this.logs.push({ text, kind });
    if (this.logs.length > 40) this.logs.shift();
    const li = document.createElement('li');
    if (kind) li.className = kind;
    li.textContent = text;
    this.logList.appendChild(li);
    while (this.logList.children.length > 8) this.logList.removeChild(this.logList.firstChild!);
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  private addFloat(x: number, y: number, text: string, color: string) {
    this.floats.push({ x, y, text, color, start: performance.now(), dur: 1300 });
    if (this.floats.length > 6) this.floats.shift();
  }

  // ============================================================
  // 渲染循环
  // ============================================================
  private loop = (now: number) => {
    this.flashes = this.flashes.filter((f) => now - f.start < f.dur);
    this.floats = this.floats.filter((f) => now - f.start < f.dur);
    if (this.roll && now - this.roll.start >= this.roll.dur) this.roll = null;
    if (this.bump && now - this.bump.start >= this.bump.dur) this.bump = null;

    const hint = this.hint;
    const hintAction = hint && hint.kind === 'next' ? hint.action : null;
    this.renderer.draw({
      board: this.board,
      state: this.present,
      progress: this.progress,
      now,
      roll: this.roll,
      bump: this.bump,
      flashes: this.flashes,
      floats: this.floats,
      hintAction,
      won: this.progress?.won ?? false,
    });
    requestAnimationFrame(this.loop);
  };
}

new GameApp();
