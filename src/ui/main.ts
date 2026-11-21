import {
  Dir,
  GameMap,
  GameState,
  Input,
  Pos,
  ToolKind,
  key,
} from '../engine/types';
import {
  blockAt,
  cloneMap,
  dirsFromTool,
  nextBlockId,
  occupiedBySolid,
  PRESETS,
  presetChainPush,
  randomMap,
  teleAt,
} from '../engine/map';
import { cloneState, createState, step } from '../engine/engine';
import { CELL, eventsToHighlights, render } from './render';
import './style.css';

interface History {
  snapshots: GameState[]; // snapshots[i] = 第 i 拍开始前的状态
  inputs: Input[]; // inputs[i] = 第 i+1 拍使用的输入
}

const TOOLS: { kind: ToolKind; label: string }[] = [
  { kind: 'wall', label: '墙' },
  { kind: 'belt-up', label: '带上' },
  { kind: 'belt-down', label: '带下' },
  { kind: 'belt-left', label: '带左' },
  { kind: 'belt-right', label: '带右' },
  { kind: 'block1', label: '方块重1' },
  { kind: 'block2', label: '方块重2' },
  { kind: 'block3', label: '方块重3' },
  { kind: 'tele-in', label: '传送入口' },
  { kind: 'tele-out', label: '传送出口' },
  { kind: 'player', label: '玩家' },
  { kind: 'eraser', label: '橡皮' },
];

class DebugApp {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private baseMap: GameMap;
  private state: GameState;
  private tool: ToolKind = 'block1';
  private hover: Pos | null = null;
  private history: History = { snapshots: [], inputs: [] };
  private replayIndex = 0; // 回放模式下已重放的拍数
  private replayMode: 'live' | 'replay' = 'live';
  private autoTimer: number | null = null;
  private statusText = '';
  private pendingPair: string | null = null;
  private static teleCounter = 0;

  constructor(root: HTMLElement) {
    this.baseMap = presetChainPush();
    this.state = createState(this.baseMap);
    this.history.snapshots = [cloneState(this.state)];

    root.innerHTML = `
      <header>
        <h1>连锁推动 × 输送带稳定结算 · 调试场景</h1>
        <span class="rule">玩家推力 3 ｜ 输送带力 2（重 3 方块带不动）｜ 每拍：玩家 → 传送① → 输送带 → 传送②</span>
      </header>
      <main>
        <div>
          <canvas id="board"></canvas>
          <p class="help" style="max-width:660px">
            键盘：<kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 移动一拍（也会推动方块），
            <kbd>Space</kbd> 空拍（只跑输送带/传送），
            <kbd>Z</kbd> 单步倒退，<kbd>R</kbd> 进入逐次回放，<kbd>Esc</kbd> 回到实时模式。
            鼠标左键用当前工具编辑地图（编辑后历史重置）。
          </p>
        </div>
        <div class="sidebar">
          <div class="card">
            <h2>编辑工具（小范围 10×8）</h2>
            <div class="palette" id="palette"></div>
            <p class="help" style="margin-bottom:0">
              先放入口再放出口，自动配对（P1、P2…）；橡皮擦除墙/带/方块/传送门，擦传送门会成对删除。
            </p>
          </div>
          <div class="card">
            <h2>场景与种子</h2>
            <div class="row">
              <select id="preset"></select>
              <button class="btn" id="load-preset">载入预设</button>
            </div>
            <div class="row" style="margin-top:8px">
              种子 <input type="number" id="seed" value="20261122" />
              <button class="btn" id="random">随机地图</button>
              <button class="btn" id="reset">重置当前地图</button>
            </div>
          </div>
          <div class="card">
            <h2>拍控制 <span id="replay-badge"></span></h2>
            <div class="tick-line">
              <span>当前拍 <b id="tick">0</b></span>
              <span id="mode">实时模式</span>
            </div>
            <div class="row">
              <button class="btn primary" id="step-up">↑</button>
              <button class="btn primary" id="step-left">←</button>
              <button class="btn primary" id="step-idle">空拍</button>
              <button class="btn primary" id="step-right">→</button>
              <button class="btn primary" id="step-down">↓</button>
            </div>
            <div class="row" style="margin-top:8px">
              <button class="btn" id="undo">单步倒退 (Z)</button>
              <button class="btn" id="replay">逐次回放 (R)</button>
              <button class="btn" id="auto">自动回放</button>
              <button class="btn" id="live">回到实时 (Esc)</button>
            </div>
            <div class="status" id="status"></div>
          </div>
          <div class="card">
            <h2>本拍结算事件（每个受影响对象均标出）</h2>
            <div class="events" id="events"><div class="help">尚无事件</div></div>
          </div>
          <div class="card">
            <h2>图例</h2>
            <div class="legend">
              <span><i class="dot" style="background:#4fd08b"></i>重量1 / 移动描边</span>
              <span><i class="dot" style="background:#ffb454"></i>重量2 / 阻塞描边</span>
              <span><i class="dot" style="background:#ff7a7a"></i>重量3 / 取消描边</span>
              <span><i class="dot" style="background:#b18cff"></i>传送相关</span>
              <span><i class="dot" style="background:#5aa2ff"></i>玩家</span>
              <span><i class="dot" style="background:#2a3f66"></i>输送带（箭头=方向）</span>
            </div>
          </div>
        </div>
      </main>`;

    this.canvas = root.querySelector('#board')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.width = this.baseMap.w * CELL;
    this.canvas.height = this.baseMap.h * CELL;

    this.bindPalette(root);
    this.bindControls(root);
    this.bindCanvas();
    this.bindKeyboard();
    this.renderAll();
  }

  // ------------------------------------------------------------- 编辑

  private bindPalette(root: HTMLElement): void {
    const pal = root.querySelector('#palette')!;
    for (const t of TOOLS) {
      const btn = document.createElement('button');
      btn.className = 'tool' + (t.kind === this.tool ? ' active' : '');
      btn.textContent = t.label;
      btn.dataset.tool = t.kind;
      btn.addEventListener('click', () => {
        this.tool = t.kind;
        pal.querySelectorAll('.tool').forEach((el) => el.classList.toggle('active', el === btn));
      });
      pal.appendChild(btn);
    }
    const sel = root.querySelector('#preset') as HTMLSelectElement;
    for (const name of Object.keys(PRESETS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  }

  private bindControls(root: HTMLElement): void {
    root.querySelector<HTMLButtonElement>('#load-preset')!.addEventListener('click', () => {
      const name = root.querySelector<HTMLSelectElement>('#preset')!.value;
      this.loadMap(PRESETS[name]());
      this.flash(`已载入预设：${name}`);
    });
    root.querySelector<HTMLButtonElement>('#random')!.addEventListener('click', () => {
      const seed = Number(root.querySelector<HTMLInputElement>('#seed')!.value) >>> 0;
      this.loadMap(randomMap(seed));
      this.flash(`已按种子 ${seed} 生成随机地图`);
    });
    root.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
      this.loadMap(cloneMap(this.baseMap));
      this.flash('已重置到当前编辑地图的初始状态');
    });

    root.querySelector('#step-up')!.addEventListener('click', () => this.takeStep('up'));
    root.querySelector('#step-down')!.addEventListener('click', () => this.takeStep('down'));
    root.querySelector('#step-left')!.addEventListener('click', () => this.takeStep('left'));
    root.querySelector('#step-right')!.addEventListener('click', () => this.takeStep('right'));
    root.querySelector('#step-idle')!.addEventListener('click', () => this.takeStep('idle'));
    root.querySelector('#undo')!.addEventListener('click', () => this.undo());
    root.querySelector('#replay')!.addEventListener('click', () => this.startReplay());
    root.querySelector('#auto')!.addEventListener('click', () => this.toggleAuto());
    root.querySelector('#live')!.addEventListener('click', () => this.endReplay());
  }

  private bindCanvas(): void {
    this.canvas.addEventListener('mousemove', (e) => {
      const p = this.toCell(e);
      this.hover = p;
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    this.canvas.addEventListener('click', (e) => {
      const p = this.toCell(e);
      if (p) this.editAt(p);
    });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const map: Record<string, Input> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };
      if (map[e.key]) {
        e.preventDefault();
        this.takeStep(map[e.key]);
      } else if (e.key === ' ') {
        e.preventDefault();
        this.takeStep('idle');
      } else if (e.key === 'z' || e.key === 'Z') {
        this.undo();
      } else if (e.key === 'r' || e.key === 'R') {
        this.startReplay();
      } else if (e.key === 'Escape') {
        this.endReplay();
      }
    });
  }

  private toCell(e: MouseEvent): Pos | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * this.baseMap.w);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * this.baseMap.h);
    if (x < 0 || y < 0 || x >= this.baseMap.w || y >= this.baseMap.h) return null;
    return { x, y };
  }

  /** 地图编辑：所有放置都做合法性校验，编辑后以新地图为基线重置历史 */
  private editAt(p: Pos): void {
    const m = this.baseMap;
    const k = key(p.x, p.y);
    const tool = this.tool;

    if (tool === 'eraser') {
      delete m.walls[k];
      delete m.belts[k];
      const b = blockAt(m, p);
      if (b) m.blocks = m.blocks.filter((x) => x.id !== b.id);
      const t = teleAt(m, p);
      if (t) m.teles = m.teles.filter((x) => x.pairId !== t.pairId); // 成对删除
      this.commitEdit(`擦除 (${p.x},${p.y})`);
      return;
    }

    if (tool.startsWith('belt-')) {
      delete m.walls[k]; // 输送带与墙互斥
      m.belts[k] = dirsFromTool(tool) as Dir;
      this.commitEdit(`在 (${p.x},${p.y}) 放置输送带`);
      return;
    }

    if (tool === 'wall') {
      if (occupiedBySolid(m, p)) return this.flash('该格已被实体占据，不能放墙');
      delete m.belts[k];
      m.walls[k] = true;
      this.commitEdit(`在 (${p.x},${p.y}) 放墙`);
      return;
    }

    if (tool.startsWith('block')) {
      const weight = Number(tool.slice(-1)) as 1 | 2 | 3;
      if (occupiedBySolid(m, p)) return this.flash('该格已被实体占据，不能放方块');
      m.blocks.push({ id: nextBlockId(), x: p.x, y: p.y, weight });
      this.commitEdit(`在 (${p.x},${p.y}) 放重量 ${weight} 方块`);
      return;
    }

    if (tool === 'player') {
      if (occupiedBySolid(m, p) && !(m.player.x === p.x && m.player.y === p.y)) {
        return this.flash('该格已被实体占据，不能放玩家');
      }
      m.player = { ...p };
      this.commitEdit(`玩家移到 (${p.x},${p.y})`);
      return;
    }

    if (tool === 'tele-in' || tool === 'tele-out') {
      const kind = tool === 'tele-in' ? 'in' : 'out';
      const solid = occupiedBySolid(m, p);
      if (solid && solid !== 'tele') return this.flash('该格已被实体占据，不能放传送门');
      const existing = teleAt(m, p);
      if (existing) {
        if (existing.kind === kind) {
          // 同类型重复放置：删掉这一对，便于重摆
          m.teles = m.teles.filter((x) => x.pairId !== existing.pairId);
          this.commitEdit(`移除传送对 ${existing.pairId}`);
          return;
        }
        return this.flash('该格已有相反类型的传送门');
      }
      if (kind === 'in') {
        // 新配对：先放入口，提示再放出口（全局单调编号，跨地图不撞 id）
        const pairId = `P${++DebugApp.teleCounter}`;
        m.teles.push({ pairId, kind: 'in', ...p });
        this.pendingPair = pairId;
        this.commitEdit(`放入口 ${pairId}，请继续放出口完成配对`);
      } else if (this.pendingPair) {
        m.teles.push({ pairId: this.pendingPair, kind: 'out', ...p });
        const pairId = this.pendingPair;
        this.pendingPair = null;
        this.commitEdit(`传送对 ${pairId} 配对完成`);
      } else {
        // 没有待配对入口：自动新建一对，入口复用一个临时不可见状态不行——
        // 改为提示用户先放入口
        this.flash('请先选择"传送入口"放入口，再放出口');
      }
    }
  }

  private commitEdit(msg: string): void {
    this.stopAuto();
    this.replayMode = 'live';
    this.state = createState(this.baseMap);
    this.history = { snapshots: [cloneState(this.state)], inputs: [] };
    this.replayIndex = 0;
    this.flash(msg);
    this.renderAll();
  }

  private loadMap(map: GameMap): void {
    this.stopAuto();
    this.baseMap = map;
    this.canvas.width = map.w * CELL;
    this.canvas.height = map.h * CELL;
    this.state = createState(map);
    this.history = { snapshots: [cloneState(this.state)], inputs: [] };
    this.replayIndex = 0;
    this.replayMode = 'live';
    this.renderAll();
  }

  // ------------------------------------------------------------- 拍推进 / 倒退 / 回放

  private takeStep(input: Input): void {
    this.stopAuto();
    if (this.replayMode === 'replay') {
      // 回放中：任何前进操作都按【录制的输入】推进一拍，保证可复现
      if (this.replayIndex >= this.history.inputs.length) {
        return this.flash('回放已到末尾，Esc 回实时模式可继续操作');
      }
      const recorded = this.history.inputs[this.replayIndex];
      this.state = cloneState(this.history.snapshots[this.replayIndex]);
      step(this.state, recorded);
      this.replayIndex += 1;
      this.renderAll();
      return;
    }

    // 实时模式：若之前倒退过，截断分叉的旧历史（线性历史，新输入覆盖旧未来）
    if (this.history.snapshots.length > this.state.tick + 1) {
      this.history.snapshots.length = this.state.tick + 1;
      this.history.inputs.length = this.state.tick;
    }
    step(this.state, input);
    this.history.inputs.push(input);
    this.history.snapshots.push(cloneState(this.state));
    this.renderAll();
  }

  private undo(): void {
    this.stopAuto();
    if (this.replayMode === 'replay') {
      if (this.replayIndex === 0) return this.flash('已在回放起点');
      this.replayIndex -= 1;
      this.state = cloneState(this.history.snapshots[this.replayIndex]);
      this.renderAll();
      return;
    }
    if (this.state.tick === 0) return this.flash('没有可倒退的拍');
    const prev = this.history.snapshots[this.state.tick - 1];
    this.state = cloneState(prev);
    this.renderAll();
    this.flash(`倒退到第 ${this.state.tick} 拍`);
  }

  private startReplay(): void {
    this.stopAuto();
    this.replayMode = 'replay';
    this.replayIndex = 0;
    this.state = cloneState(this.history.snapshots[0]);
    this.flash('回放模式：用方向键/空拍按钮逐次前进，Z 后退');
    this.renderAll();
  }

  private endReplay(): void {
    this.stopAuto();
    this.replayMode = 'live';
    this.state = cloneState(this.history.snapshots[this.history.snapshots.length - 1]);
    this.flash('回到实时模式（最新一拍）');
    this.renderAll();
  }

  private toggleAuto(): void {
    if (this.autoTimer !== null) {
      this.stopAuto();
      return;
    }
    if (this.replayMode !== 'replay') this.startReplay();
    this.autoTimer = window.setInterval(() => {
      if (this.replayIndex >= this.history.inputs.length) {
        this.stopAuto();
        return;
      }
      this.takeStep(this.history.inputs[this.replayIndex]); // 回放模式下取录制输入
    }, 600);
    this.flash('自动回放中…');
  }

  private stopAuto(): void {
    if (this.autoTimer !== null) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
  }

  // ------------------------------------------------------------- 渲染

  private flash(msg: string): void {
    this.statusText = msg;
    this.renderAll();
  }

  private draw(): void {
    render(this.ctx, this.state, eventsToHighlights(this.state.events), this.hover);
  }

  private renderAll(): void {
    this.draw();
    const root = document.querySelector('#app')!;
    root.querySelector<HTMLElement>('#tick')!.textContent = String(this.state.tick);
    root.querySelector<HTMLElement>('#mode')!.textContent =
      this.replayMode === 'replay' ? `回放 ${this.replayIndex}/${this.history.inputs.length}` : '实时模式';
    const badge = root.querySelector<HTMLElement>('#replay-badge')!;
    badge.innerHTML = this.replayMode === 'replay' ? '<span class="replay-badge">REPLAY</span>' : '';
    root.querySelector<HTMLElement>('#status')!.textContent = this.statusText;

    const box = root.querySelector<HTMLElement>('#events')!;
    if (this.state.events.length === 0) {
      box.innerHTML = '<div class="help">本拍无事件（空拍且无输送带/传送活动）</div>';
      return;
    }
    box.innerHTML = '';
    for (const e of this.state.events) {
      const div = document.createElement('div');
      const tone =
        e.kind.includes('cancel') || e.kind === 'push-blocked'
          ? e.kind === 'belt-cancel'
            ? 'cancel'
            : 'blocked'
          : e.kind.includes('blocked')
            ? 'blocked'
            : e.kind.startsWith('teleport')
              ? 'tele'
              : 'move';
      div.className = `ev ${tone}`;
      div.innerHTML = `<span class="phase">[${e.phase}]</span><span class="subj">${e.subject}</span> ${e.detail}`;
      box.appendChild(div);
    }
  }
}

new DebugApp(document.querySelector('#app')!);
