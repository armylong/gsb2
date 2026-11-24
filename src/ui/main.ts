// 主控制器：初始化、键盘/鼠标交互、侧栏刷新与推断流程。

import { GameState, SCAN_COOLDOWN } from '../core/game.js';
import { SCENARIOS } from '../core/scenarios.js';
import {
  DepthLevel,
  DIR_NAMES,
  Observation,
  Visibility,
  Zone,
} from '../core/types.js';
import { verifyChain, type VerifyResult } from '../core/verify.js';
import { Renderer, describeDepth } from './renderer.js';

type Mode = 'move' | 'mark';

class App {
  private game: GameState;
  private renderer: Renderer;
  private mode: Mode = 'move';
  private hover: { x: number; y: number } | null = null;
  private toastTimer: number | null = null;

  /** 供调试/自动化钩子使用的只读状态入口 */
  get gameState(): GameState {
    return this.game;
  }

  private el = {
    canvas: document.getElementById('map') as HTMLCanvasElement,
    title: document.getElementById('scenario-title') as HTMLElement,
    desc: document.getElementById('scenario-desc') as HTMLElement,
    clock: document.getElementById('clock') as HTMLElement,
    select: document.getElementById('scenario-select') as HTMLSelectElement,
    seed: document.getElementById('seed-input') as HTMLInputElement,
    restart: document.getElementById('btn-restart') as HTMLButtonElement,
    modeMove: document.getElementById('mode-move') as HTMLButtonElement,
    modeMark: document.getElementById('mode-mark') as HTMLButtonElement,
    scan: document.getElementById('btn-scan') as HTMLButtonElement,
    advance: document.getElementById('btn-advance') as HTMLButtonElement,
    obsList: document.getElementById('observation-list') as HTMLElement,
    chainList: document.getElementById('chain-list') as HTMLElement,
    gap: document.getElementById('btn-gap') as HTMLButtonElement,
    undo: document.getElementById('btn-undo') as HTMLButtonElement,
    clearChain: document.getElementById('btn-clear-chain') as HTMLButtonElement,
    verify: document.getElementById('btn-verify') as HTMLButtonElement,
    verifyResult: document.getElementById('verify-result') as HTMLElement,
    toast: document.getElementById('toast') as HTMLElement,
  };

  constructor() {
    for (const s of SCENARIOS) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      this.el.select.appendChild(opt);
    }

    this.game = new GameState(SCENARIOS[0].id);
    this.renderer = new Renderer(this.el.canvas);
    this.renderer.resize(this.game.scenario.width, this.game.scenario.height);
    this.el.seed.value = this.game.scenario.seed;

    this.bind();
    this.refresh();
  }

  private bind(): void {
    this.el.select.addEventListener('change', () => this.restart(this.el.select.value));
    this.el.restart.addEventListener('click', () =>
      this.restart(this.el.select.value, this.el.seed.value),
    );
    this.el.modeMove.addEventListener('click', () => this.setMode('move'));
    this.el.modeMark.addEventListener('click', () => this.setMode('mark'));
    this.el.scan.addEventListener('click', () => this.doScan());
    this.el.advance.addEventListener('click', () => {
      this.game.advance(10);
      this.toast('时间快进 10 分：迎风口的脚印正在被新雪填平。');
      this.refresh();
    });
    this.el.gap.addEventListener('click', () => {
      const r = this.game.addGap();
      if (!r.ok) this.toast(r.reason ?? '无法插入跳格', 'error');
      this.refresh();
    });
    this.el.undo.addEventListener('click', () => {
      this.game.removeLastEntry();
      this.refresh();
    });
    this.el.clearChain.addEventListener('click', () => {
      this.game.clearChain();
      this.el.verifyResult.textContent = '';
      this.el.verifyResult.className = 'verify';
      this.refresh();
    });
    this.el.verify.addEventListener('click', () => this.doVerify());

    window.addEventListener('keydown', (e) => this.onKey(e));
    this.el.canvas.addEventListener('mousemove', (e) => {
      this.hover = this.renderer.cellFromPixel(e.clientX, e.clientY);
      this.draw();
    });
    this.el.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    this.el.canvas.addEventListener('click', (e) => this.onCanvasClick(e));
  }

  private restart(scenarioId: string, seed?: string): void {
    this.game = new GameState(scenarioId, seed);
    this.el.seed.value = this.game.scenario.seed;
    this.renderer.resize(this.game.scenario.width, this.game.scenario.height);
    this.el.verifyResult.textContent = '';
    this.el.verifyResult.className = 'verify';
    this.setMode('move');
    this.toast(`已重开「${this.game.scenario.title}」，时刻回到第 ${this.game.now} 分。`, 'ok');
    this.refresh();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.el.modeMove.classList.toggle('active', mode === 'move');
    this.el.modeMark.classList.toggle('active', mode === 'mark');
    this.draw();
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'f') {
      e.preventDefault();
      this.doScan();
      return;
    }
    if (k === 't') {
      this.game.advance(10);
      this.toast('时间快进 10 分。');
      this.refresh();
      return;
    }
    if (k === 'm') {
      this.setMode(this.mode === 'move' ? 'mark' : 'move');
      return;
    }
    const moves: Record<string, [number, number]> = {
      w: [0, -1],
      arrowup: [0, -1],
      s: [0, 1],
      arrowdown: [0, 1],
      a: [-1, 0],
      arrowleft: [-1, 0],
      d: [1, 0],
      arrowright: [1, 0],
    };
    const m = moves[k];
    if (m) {
      e.preventDefault();
      const ok = this.game.move(m[0], m[1]);
      if (!ok) this.toast('那边走不通（岩石或边界）。', 'error');
      this.refresh();
    }
  }

  private onCanvasClick(e: MouseEvent): void {
    const { x, y } = this.renderer.cellFromPixel(e.clientX, e.clientY);
    if (this.game.zoneAt(x, y) === Zone.Block) {
      this.toast('岩石挡路。', 'error');
      return;
    }
    if (this.mode === 'move') {
      const ok = this.game.moveTo(x, y);
      if (!ok) this.toast('只能走到上下左右相邻的格子。', 'error');
      this.refresh();
      return;
    }
    this.markCell(x, y);
  }

  /** 标记模式：把已观察格加入推断链；叠踩格先让玩家选第几条足迹 */
  private markCell(x: number, y: number): void {
    const obs = this.game.getObservation(x, y);
    if (!obs) {
      this.toast('这一格还没观察过：先在移动模式踩过去，或靠近后扫雪。', 'error');
      return;
    }
    if (obs.impressions.length === 0) {
      this.toast('这一格的足迹已被新雪完全盖住，没有可见线索可圈。', 'error');
      return;
    }
    let pick = 0;
    if (obs.impressions.length >= 2) {
      const label = obs.impressions
        .map(
          (v, i) =>
            `${i + 1}. ${v.visibility === Visibility.Visible ? `朝${v.dir === null ? '?' : DIR_NAMES[v.dir]} / ${describeDepth(v.depth)}` : '浅痕'}`,
        )
        .join('　');
      const input = window.prompt(
        `这格叠了 ${obs.impressions.length} 条足迹（从新到旧）：\n${label}\n\n输入要圈的编号（1-${obs.impressions.length}）：`,
        '1',
      );
      if (input === null) return;
      const n = Number(input.trim());
      if (!Number.isInteger(n) || n < 1 || n > obs.impressions.length) {
        this.toast('编号无效。', 'error');
        return;
      }
      pick = n - 1;
    }
    const r = this.game.addObsEntry(x, y, pick);
    if (!r.ok) this.toast(r.reason ?? '无法加入推断链。', 'error');
    this.refresh();
  }

  private doScan(): void {
    const cooled: string[] = [];
    const waiting: string[] = [];
    for (const r of this.game.scan()) {
      const label = `(${r.x},${r.y})`;
      (r.cooled ? cooled : waiting).push(label);
    }
    const parts: string[] = [];
    if (cooled.length) parts.push(`扫到 ${cooled.length} 格`);
    if (waiting.length)
      parts.push(`${waiting.length} 格在 ${SCAN_COOLDOWN} 分冷却内，沿用旧记录`);
    this.toast(parts.join('；') || '周围没有可扫的格子。');
    this.refresh();
  }

  private doVerify(): void {
    const result: VerifyResult = verifyChain(this.game);
    this.el.verifyResult.className = `verify ${result.verdict}`;
    this.el.verifyResult.textContent = result.message;
    this.toast(result.message, result.verdict === 'contradiction' ? 'error' : 'ok');
  }

  private toast(msg: string, kind: 'error' | 'ok' | '' = ''): void {
    this.el.toast.textContent = msg;
    this.el.toast.hidden = false;
    this.el.toast.className = `toast ${kind}`;
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.el.toast.hidden = true;
    }, 3600);
  }

  private refresh(): void {
    this.el.title.textContent = this.game.scenario.title;
    this.el.desc.textContent = this.game.scenario.description;
    this.el.clock.textContent = String(this.game.now);
    this.el.select.value = this.game.scenario.id;
    this.draw();
    this.renderObservations();
    this.renderChain();
  }

  private draw(): void {
    this.renderer.render(this.game, { mode: this.mode, hover: this.hover });
  }

  private renderObservations(): void {
    const list = [...this.game.observations.values()].sort((a, b) =>
      a.atTime === b.atTime ? a.y - b.y || a.x - b.x : a.atTime - b.atTime,
    );
    if (list.length === 0) {
      this.el.obsList.className = 'obs-list empty';
      this.el.obsList.textContent =
        '还没有观察记录。踩入格子或扫雪后，看得见的足迹会列在这里。';
      return;
    }
    this.el.obsList.className = 'obs-list';
    this.el.obsList.replaceChildren(
      ...list.map((o) => this.obsElement(o)),
    );
  }

  private obsElement(o: Observation): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'obs-item';
    const head = document.createElement('div');
    head.innerHTML =
      `<span class="pos">(${o.x},${o.y})</span> ` +
      `<span class="meta">${o.stepped ? '踩入观察' : '扫雪观察'} · 时刻 ${o.atTime} · ${zoneName(this.game.zoneAt(o.x, o.y))}</span>`;
    wrap.appendChild(head);
    if (o.impressions.length === 0) {
      const none = document.createElement('div');
      none.className = 'meta';
      none.textContent = '当前看不到足迹（已被新雪盖满，或从未有人走过）。';
      wrap.appendChild(none);
    } else {
      o.impressions.forEach((v, i) => {
        const line = document.createElement('div');
        line.className = 'imp-line';
        const tag = o.impressions.length > 1 ? `#${i + 1} ` : '';
        if (v.visibility === Visibility.Trace) {
          line.textContent = `${tag}浅痕：只剩压痕，方向与深浅不可读`;
        } else {
          line.textContent = `${tag}脚印：朝向 ${v.dir === null ? '?' : DIR_NAMES[v.dir]} · 深浅 ${depthName(v.depth)} · 覆盖率 ${Math.round(v.cover * 100)}%`;
        }
        wrap.appendChild(line);
      });
    }
    return wrap;
  }

  private renderChain(): void {
    const chain = this.game.chain;
    if (chain.length === 0) {
      this.el.chainList.className = 'chain-list empty';
      this.el.chainList.textContent = '空。在标记模式下按顺序点选足迹。';
      return;
    }
    this.el.chainList.className = 'chain-list';
    const nodes: HTMLElement[] = [];
    let n = 0;
    chain.forEach((entry) => {
      if (entry.kind === 'gap') {
        const g = document.createElement('div');
        g.className = 'chain-item chain-gap';
        g.textContent = '⤳ 跳过一格（不确定）';
        nodes.push(g);
        return;
      }
      n++;
      const obs = this.game.getObservation(entry.x, entry.y);
      const v = obs?.impressions[entry.pick];
      const div = document.createElement('div');
      div.className = 'chain-item';
      if (v && v.visibility === Visibility.Visible) {
        div.innerHTML =
          `<span class="pos">${n}. (${entry.x},${entry.y})</span><br>` +
          `<span class="meta">朝向 ${v.dir === null ? '?' : DIR_NAMES[v.dir]} · 深浅 ${depthName(v.depth)}</span>`;
      } else {
        div.innerHTML =
          `<span class="pos">${n}. (${entry.x},${entry.y})</span><br>` +
          `<span class="meta">浅痕（无方向/深浅信息）</span>`;
      }
      nodes.push(div);
    });
    this.el.chainList.replaceChildren(...nodes);
  }
}

function zoneName(z: Zone): string {
  switch (z) {
    case Zone.Wind:
      return '迎风口';
    case Zone.Shelter:
      return '避风区';
    case Zone.Block:
      return '阻挡';
    default:
      return '普通积雪';
  }
}

function depthName(d: DepthLevel): string {
  switch (d) {
    case DepthLevel.Deep:
      return '深';
    case DepthLevel.Medium:
      return '中';
    case DepthLevel.Light:
      return '浅';
    default:
      return '浅痕';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  // 调试/自动化钩子：供 tools/e2e.mjs 驱动内部状态，不影响正常玩法。
  // 用 getter 保证重开/换题面后拿到的始终是当前 GameState。
  Object.defineProperty(window, '__snow', {
    configurable: true,
    get() {
      return { app, game: app.gameState };
    },
  });
});
