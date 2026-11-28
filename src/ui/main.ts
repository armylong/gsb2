import {
  colorName,
  colorOfLayers,
  createGame,
  evaluate,
  indexOf,
  inkName,
  layerSourceLabel,
  mixColor,
  previewStamp,
  stamp,
  toggleMask,
  undo,
  undoLabel,
} from '../core/game';
import { flipOrientation, orientationLabel, rotateClockwise, mapHoles } from '../core/geometry';
import { runScript } from '../core/script';
import type { ScriptRun, StepResult, VerificationScript } from '../core/script';
import type { Coord, Evaluation, GameState, InkId, LevelDef, Orientation } from '../core/types';
import type { StampPreview } from '../core/game';
import { LEVELS, getLevel } from '../data/levels';
import { scriptsForLevel, flowerSource, heartSource } from '../data/scripts';
import { clear, el, icon } from './dom';
import { computeMetrics, drawBoard, drawPlanThumbnail, drawStencilIcon, drawCellSwatch } from './render';
import type { BoardMetrics, BoardView } from './render';
import './style.css';

type Mode = 'stamp' | 'mask' | 'inspect';

const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

interface DemoState {
  script: VerificationScript;
  run: ScriptRun;
  /** 已执行到第几步；0 表示尚未执行任何步骤。 */
  index: number;
  playing: boolean;
  timer: number | null;
}

const COLUMN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEMO_INTERVAL = 1500;

function cellLabel(c: Coord): string {
  return `${COLUMN[c.x] ?? c.x + 1}${c.y + 1}`;
}

function swatch(level: LevelDef, color: string, size = 26): HTMLCanvasElement {
  const canvas = el('canvas', { class: 'swatch' });
  drawCellSwatch(canvas, level, color);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  return canvas;
}

function inkDot(level: LevelDef, ink: InkId): HTMLSpanElement {
  const def = level.inks.find((i) => i.id === ink);
  const color = def?.color ?? level.paperColor;
  const entry = level.palette.find((p) => p.id === color);
  const span = el('span', { class: 'ink-dot', text: entry?.symbol ?? '?', title: def?.name ?? ink });
  span.style.background = entry?.css ?? '#999';
  span.style.color = entry?.inkOn === 'light' ? '#fff8ef' : '#33261a';
  return span;
}

class App {
  private level: LevelDef;
  private state: GameState;
  private states = new Map<string, GameState>();
  private stencilId: string;
  private orientationByStencil = new Map<string, Orientation>();
  private orientation: Orientation;
  private inkId: string;
  private pivot: Coord;
  private mode: Mode = 'stamp';
  private hover: Coord | null = null;
  private selected: Coord | null = null;
  private showPlan = true;
  private pinned = false;
  private demo: DemoState | null = null;
  private metrics: BoardMetrics;
  private toastTimer = 0;
  private resetArmed = false;

  private canvas: HTMLCanvasElement;
  private boardWrap: HTMLDivElement;
  private boardStatus: HTMLDivElement;
  private previewStrip: HTMLDivElement;
  private inkList: HTMLDivElement;
  private stencilList: HTMLDivElement;
  private stencilControls: HTMLDivElement;
  private inspector: HTMLDivElement;
  private historyList: HTMLOListElement;
  private planProgress: HTMLDivElement;
  private diffList: HTMLDivElement;
  private mixList: HTMLDivElement;
  private planThumb: HTMLCanvasElement;
  private levelTabs: HTMLDivElement;
  private levelTitle: HTMLHeadingElement;
  private levelSubtitle: HTMLParagraphElement;
  private stampButton: HTMLButtonElement;
  private pinButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private resetButton: HTMLButtonElement;
  private modeButtons: Record<Mode, HTMLButtonElement>;
  private toast: HTMLDivElement;
  private drawer: HTMLElement;
  private drawerBody: HTMLDivElement;
  private drawerFooter: HTMLDivElement;
  private demoBar: HTMLDivElement;
  private demoLabel: HTMLSpanElement;
  private demoButtons: { prev: HTMLButtonElement; play: HTMLButtonElement; next: HTMLButtonElement; exit: HTMLButtonElement };
  private helpDialog: HTMLDialogElement;
  private root: HTMLDivElement;

  constructor(private mount: HTMLElement) {
    this.level = LEVELS[0]!;
    this.stencilId = this.level.stencils[0]!.id;
    this.orientation = { rotation: 0, flipped: false };
    this.orientationByStencil.set(this.stencilId, this.orientation);
    this.inkId = this.level.inks[0]!.id;
    this.pivot = { x: Math.floor(this.level.width / 2) - 1, y: Math.floor(this.level.height / 2) - 1 };
    this.state = createGame(this.level);
    this.metrics = computeMetrics(this.level, 620);

    this.root = el('div', { class: 'app' });
    this.levelTabs = el('div', { class: 'level-tabs', attrs: { role: 'tablist', 'aria-label': '关卡' } });
    this.levelTitle = el('h2', { class: 'level-title' });
    this.levelSubtitle = el('p', { class: 'level-subtitle' });
    this.boardStatus = el('div', { class: 'board-status', attrs: { 'aria-live': 'polite' } });
    this.canvas = el('canvas', { class: 'board-canvas', attrs: { role: 'img', 'aria-label': '印画纸面' } });
    this.boardWrap = el('div', { class: 'board-wrap' }, this.canvas);
    this.previewStrip = el('div', { class: 'preview-strip', attrs: { 'aria-live': 'polite' } });
    this.inkList = el('div', { class: 'ink-list' });
    this.stencilList = el('div', { class: 'stencil-list' });
    this.stencilControls = el('div', { class: 'stencil-controls' });
    this.inspector = el('div', { class: 'inspector' });
    this.historyList = el('ol', { class: 'history-list' });
    this.planProgress = el('div', { class: 'plan-progress' });
    this.diffList = el('div', { class: 'diff-list' });
    this.mixList = el('div', { class: 'mix-list' });
    this.planThumb = el('canvas', { class: 'plan-thumb', attrs: { 'aria-label': '样图缩略' } });
    this.toast = el('div', { class: 'toast', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.demoBar = el('div', { class: 'demo-bar', attrs: { hidden: true, 'aria-live': 'polite' } });
    this.demoLabel = el('span', { class: 'demo-label' });
    this.drawer = el('aside', { class: 'drawer', attrs: { 'aria-label': '操作串验证' } });
    this.drawerBody = el('div', { class: 'drawer-body' });
    this.drawerFooter = el('div', { class: 'drawer-footer' });

    this.stampButton = el('button', { class: 'btn primary stamp-btn', attrs: { type: 'button' } }, icon('stamp'), el('span', { text: '盖印' }), el('kbd', { text: '↵' }));
    this.pinButton = el('button', { class: 'btn ghost', attrs: { type: 'button' } }, icon('eye'), el('span', { text: '定格预演' }));
    this.undoButton = el('button', { class: 'btn ghost', attrs: { type: 'button' } }, icon('undo'), el('span', { text: '撤回' }));
    this.resetButton = el('button', { class: 'btn ghost subtle', attrs: { type: 'button' } }, icon('reset'), el('span', { text: '重置' }));
    this.modeButtons = {
      stamp: el('button', { class: 'seg', attrs: { type: 'button', 'aria-pressed': 'true' } }, icon('stamp'), el('span', { text: '盖印' })),
      mask: el('button', { class: 'seg', attrs: { type: 'button', 'aria-pressed': 'false' } }, icon('mask'), el('span', { text: '挡墨纸' }), el('kbd', { text: 'M' })),
      inspect: el('button', { class: 'seg', attrs: { type: 'button', 'aria-pressed': 'false' } }, icon('inspect'), el('span', { text: '查看' })),
    };
    this.demoButtons = {
      prev: el('button', { class: 'btn tiny ghost', attrs: { type: 'button', title: '上一步' }, text: '←' }),
      play: el('button', { class: 'btn tiny primary', attrs: { type: 'button' }, text: '暂停' }),
      next: el('button', { class: 'btn tiny ghost', attrs: { type: 'button', title: '下一步' }, text: '→' }),
      exit: el('button', { class: 'btn tiny ghost', attrs: { type: 'button' }, text: '退出演示' }),
    };
    this.helpDialog = el('dialog', { class: 'help-dialog' });

    this.buildSkeleton();
    this.mount.append(this.root);
    this.wire();
    this.resize();
    this.render();

  }

  private get evaluation(): Evaluation {
    return evaluate(this.level, this.viewState);
  }

  private get demoIndex(): number {
    return this.demo ? this.demo.index : 0;
  }

  private get viewState(): GameState {
    if (!this.demo) return this.state;
    if (this.demo.index === 0) return createGame(this.level);
    return this.demo.run.steps[this.demo.index - 1]!.state;
  }

  private get preview(): StampPreview | null {
    if (this.demo) return null;
    if (this.mode === 'mask' || this.mode === 'inspect') return null;
    return previewStamp(this.level, this.state, this.currentRequest());
  }

  private currentRequest() {
    return {
      stencilId: this.stencilId,
      ink: this.inkId,
      pivot: this.pivot,
      orientation: this.orientation,
    };
  }

  private buildSkeleton(): void {
    const brand = el(
      'div',
      { class: 'brand' },
      el('div', { class: 'brand-mark', text: '叠' }),
      el('div', { class: 'brand-text' }, el('h1', { text: '叠印' }), el('p', { text: '纸版 · 透明墨 · 留白' })),
    );

    const verifyButton = el(
      'button',
      { class: 'btn ghost', attrs: { type: 'button' }, on: { click: () => this.openDrawer() } },
      icon('check'),
      el('span', { text: '操作串验证' }),
    );
    const helpButton = el(
      'button',
      { class: 'btn ghost', attrs: { type: 'button', title: '玩法说明' }, on: { click: () => this.helpDialog.showModal() } },
      el('span', { text: '玩法' }),
    );

    const topbar = el(
      'header',
      { class: 'topbar' },
      brand,
      this.levelTabs,
      el('div', { class: 'top-actions' }, helpButton, verifyButton),
    );

    const headLeft = el('div', { class: 'board-head-left' }, this.levelTitle, this.levelSubtitle);
    const planToggle = el('label', { class: 'plan-toggle' });
    const planCheckbox = el('input', { attrs: { type: 'checkbox' } });
    planCheckbox.checked = this.showPlan;
    planToggle.append(planCheckbox, el('span', { text: '显示样图标记' }));

    const head = el('div', { class: 'board-head' }, headLeft, this.boardStatus, planToggle);

    const previewLabel = el('div', { class: 'preview-strip-inner' });
    this.previewStrip.append(previewLabel);

    const actionBar = el(
      'div',
      { class: 'action-bar' },
      el(
        'div',
        { class: 'mode-switch', attrs: { role: 'group', 'aria-label': '指针模式' } },
        this.modeButtons.stamp,
        this.modeButtons.mask,
        this.modeButtons.inspect,
      ),
      el('div', { class: 'action-buttons' }, this.pinButton, this.undoButton, this.stampButton),
      this.resetButton,
    );

    this.demoBar.append(
      el('span', { class: 'demo-badge', text: '演示' }),
      this.demoLabel,
      el('div', { class: 'demo-controls' }, this.demoButtons.prev, this.demoButtons.play, this.demoButtons.next, this.demoButtons.exit),
    );

    const boardPanel = el(
      'section',
      { class: 'board-panel' },
      head,
      el('div', { class: 'notice-slot' }, this.toast, this.demoBar),
      this.boardWrap,
      this.previewStrip,
      actionBar,
    );

    const planCard = el(
      'section',
      { class: 'card' },
      el('h3', {}, el('span', { text: '样图' }), el('span', { class: 'card-hint', text: '对照提示' })),
      el('div', { class: 'plan-layout' }, this.planThumb, this.planProgress),
      this.diffList,
      this.mixList,
    );

    const inkCard = el(
      'section',
      { class: 'card' },
      el('h3', {}, el('span', { text: '墨色' }), el('span', { class: 'card-hint', text: '按实际接触格结算' })),
      this.inkList,
    );

    const stencilCard = el(
      'section',
      { class: 'card' },
      el('h3', {}, el('span', { text: '模板' }), el('span', { class: 'card-hint', text: 'R 转动 · F 翻面' })),
      this.stencilList,
      this.stencilControls,
    );

    const inspectCard = el(
      'section',
      { class: 'card inspector-card' },
      el('h3', {}, el('span', { text: '格子详情' }), el('span', { class: 'card-hint', text: '叠色来源' })),
      this.inspector,
    );

    const historyCard = el(
      'section',
      { class: 'card history-card' },
      el('h3', {}, el('span', { text: '操作记录' }), el('span', { class: 'card-hint', text: 'Z 撤回' })),
      this.historyList,
    );

    const sidebar = el('aside', { class: 'sidebar' }, planCard, inkCard, stencilCard, inspectCard, historyCard);
    const workspace = el('main', { class: 'workspace' }, boardPanel, sidebar);

    this.drawer.append(
      el(
        'div',
        { class: 'drawer-head' },
        el('div', {}, el('h2', { text: '操作串验证' }), el('p', { class: 'drawer-sub', text: '一份可重复执行的印画指令，逐步核对规则是否成立。' })),
        el('button', { class: 'btn tiny ghost close-drawer', attrs: { type: 'button', 'aria-label': '关闭' }, on: { click: () => this.closeDrawer() } }, icon('cross')),
      ),
      this.drawerBody,
      this.drawerFooter,
    );

    this.helpDialog.append(this.buildHelp());
    this.root.append(topbar, workspace, this.drawer, this.helpDialog);

    planCheckbox.addEventListener('change', () => {
      this.showPlan = planCheckbox.checked;
      this.draw();
    });
  }

  private buildHelp(): HTMLElement {
    return el(
      'div',
      { class: 'help-content' },
      el('h2', { text: '玩法' }),
      el('p', {
        text: '纸板只有有限格。选一种透明墨、一片带孔模板，转动或翻面后盖下；每格的最终颜色只由这一格上叠过的墨层顺序决定。',
      }),
      el('ol', { class: 'help-list' },
        el('li', {}, el('strong', { text: '孔位预览：' }), '移动指针（或方向键）时，红虚线是本印会碰到的孔；纸边的小叉表示出界孔；虚线小格表示被挡墨纸保护。悬停时才填入盖上去后的颜色。'),
        el('li', {}, el('strong', { text: '墨量结算：' }), '按实际接触到的棋盘格数计费，同一格反复盖也各计一次。墨不够时整次拒绝，不会先染几格再报错。'),
        el('li', {}, el('strong', { text: '挡墨纸：' }), '可随时贴上或收回。被挡住的格完全不沾墨，拿掉后原色仍在。'),
        el('li', {}, el('strong', { text: '保留格：' }), '样图里带斜线的格必须保持干净；一旦沾墨整次印画判失败，可用「撤回」返还这一印的用量。'),
        el('li', {}, el('strong', { text: '查看来源：' }), '切到「查看」模式后点任意格，右侧会列出这一格从早到晚的每一层墨来自第几印、哪片模板与朝向。'),
        el('li', {}, el('strong', { text: '不耗墨预演：' }), '「定格预演」会冻结当前盖印效果供仔细对照，不消耗墨量，也不会解开谜题。'),
      ),
      el('h3', { text: '快捷键' }),
      el(
        'div',
        { class: 'keys' },
        el('span', {}, el('kbd', { text: 'R' }), '转动模板'),
        el('span', {}, el('kbd', { text: 'F' }), '翻面'),
        el('span', {}, el('kbd', { text: '↵' }), '盖印'),
        el('span', {}, el('kbd', { text: 'Z' }), '撤回'),
        el('span', {}, el('kbd', { text: 'M' }), '挡墨纸模式'),
        el('span', {}, el('kbd', { text: 'I' }), '查看模式'),
        el('span', {}, el('kbd', { text: 'P' }), '定格预演'),
        el('span', {}, el('kbd', { text: '←↑↓→' }), '移动模板定位'),
        el('span', {}, el('kbd', { text: '[ ]' }), '切换模板'),
        el('span', {}, el('kbd', { text: 'Esc' }), '退出模式 / 关闭面板'),
      ),
      el('form', { attrs: { method: 'dialog' } }, el('button', { class: 'btn primary', attrs: { type: 'submit' }, text: '知道了' })),
    );
  }

  private wire(): void {
    this.levelTabs.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLButtonElement>('[data-level]');
      if (!button) return;
      this.switchLevel(button.dataset.level!);
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (this.demo) return;
      if (event.pointerType === 'touch' && !event.isPrimary) return;
      const cell = this.cellFromEvent(event);
      this.hover = cell;
      if (cell && this.mode === 'stamp' && !this.pinned && event.pointerType !== 'touch') {
        this.pivot = cell;
      }
      if (event.pointerType === 'touch' && !cell) this.hover = null;
      this.draw();
      this.updatePreviewStrip();
      this.canvas.style.cursor = !cell ? 'default' : this.mode === 'inspect' ? 'pointer' : this.mode === 'mask' ? 'copy' : 'crosshair';
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
    });
    this.canvas.addEventListener('click', (event) => {
      if (this.demo) return;
      const cell = this.cellFromEvent(event);
      if (!cell) return;
      if (this.mode === 'inspect') {
        this.selected = cell;
        this.render();
        return;
      }
      if (this.mode === 'mask') {
        this.applyMask(cell);
        return;
      }
      if (this.pinned) {
        this.toastMessage('预演已定格；再点一次「定格预演」或按 P 解除。', 'info');
        return;
      }
      this.pivot = cell;
      if (TOUCH) {
        this.hover = cell;
        this.draw();
        this.toastMessage(`已定位到 ${cellLabel(cell)}（${this.previewStatement()}），按「盖印」落印。`, 'info');
        return;
      }
      this.commitStamp();
    });

    this.stampButton.addEventListener('click', () => {
      if (this.demo) return;
      if (this.mode !== 'stamp') {
        this.setMode('stamp');
        this.toastMessage('已回到盖印模式。', 'info');
        return;
      }
      this.commitStamp();
    });
    this.pinButton.addEventListener('click', () => {
      this.pinned = !this.pinned;
      if (this.pinned) this.setMode('stamp');
      this.render();
      this.toastMessage(this.pinned ? '预演已定格：反复对照也不会耗墨。' : '已解除定格。', 'info');
    });
    this.undoButton.addEventListener('click', () => this.doUndo());
    this.resetButton.addEventListener('click', () => this.doReset());
    this.modeButtons.stamp.addEventListener('click', () => this.setMode('stamp'));
    this.modeButtons.mask.addEventListener('click', () => this.setMode('mask'));
    this.modeButtons.inspect.addEventListener('click', () => this.setMode('inspect'));

    this.demoButtons.prev.addEventListener('click', () => this.pauseDemo(this.indexDemo(-1)));
    this.demoButtons.next.addEventListener('click', () => this.pauseDemo(this.indexDemo(1)));
    this.demoButtons.play.addEventListener('click', () => this.togglePlay());
    this.demoButtons.exit.addEventListener('click', () => this.exitDemo());

    window.addEventListener('keydown', (event) => this.onKey(event));
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.demo?.playing) this.setDemoPlaying(false);
    });
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (this.helpDialog.open) return;
    if (event.key === 'Escape') {
      if (this.demo) {
        this.exitDemo();
      } else if (this.drawer.classList.contains('open')) {
        this.closeDrawer();
      } else if (this.pinned) {
        this.pinned = false;
        this.render();
      } else if (this.mode !== 'stamp') {
        this.setMode('stamp');
      }
      return;
    }
    if (this.demo) {
      if (event.key === ' ') {
        event.preventDefault();
        this.togglePlay();
      } else if (event.key === 'ArrowRight') {
        this.pauseDemo(this.indexDemo(1));
      } else if (event.key === 'ArrowLeft') {
        this.pauseDemo(this.indexDemo(-1));
      }
      return;
    }
    if (event.key === 'Enter' && (target.tagName === 'BUTTON' || target.tagName === 'A')) return;
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const delta =
        event.key === 'ArrowLeft' ? { x: -1, y: 0 } :
        event.key === 'ArrowRight' ? { x: 1, y: 0 } :
        event.key === 'ArrowUp' ? { x: 0, y: -1 } : { x: 0, y: 1 };
      this.movePivot(delta);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'r') {
      event.preventDefault();
      this.rotate();
    } else if (key === 'f') {
      event.preventDefault();
      this.flip();
    } else if (key === 'z') {
      event.preventDefault();
      this.doUndo();
    } else if (key === 'm') {
      event.preventDefault();
      this.setMode(this.mode === 'mask' ? 'stamp' : 'mask');
    } else if (key === 'i') {
      event.preventDefault();
      this.setMode(this.mode === 'inspect' ? 'stamp' : 'inspect');
    } else if (key === 'p') {
      event.preventDefault();
      this.pinButton.click();
    } else if (key === 'enter') {
      if (this.mode !== 'stamp') return;
      event.preventDefault();
      this.commitStamp();
    } else if (key === '[' || key === ']') {
      event.preventDefault();
      this.cycleStencil(key === ']' ? 1 : -1);
    } else if (/^[1-9]$/.test(key)) {
      const ink = this.level.inks[Number(key) - 1];
      if (ink) {
        this.inkId = ink.id;
        this.render();
        this.draw();
      }
    }
  }

  private cellFromEvent(event: PointerEvent | MouseEvent): Coord | null {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = ((event.clientX - rect.left) / rect.width) * this.metrics.width;
    const cssY = ((event.clientY - rect.top) / rect.height) * this.metrics.height;
    const x = Math.floor((cssX - this.metrics.margin) / this.metrics.cell);
    const y = Math.floor((cssY - this.metrics.margin) / this.metrics.cell);
    if (x < 0 || y < 0 || x >= this.level.width || y >= this.level.height) return null;
    return { x, y };
  }

  private resize(): void {
    const availableWidth = (this.boardWrap.clientWidth || 620) - 4;
    // 桌面端预留标题、操作栏与预览条的纵向空间，尽量让整盘落在一屏内；窄屏不按高度收。
    const reserved = 350;
    const availableHeight = window.innerHeight - reserved;
    this.metrics = computeMetrics(this.level, availableWidth, availableHeight);
    this.draw();
  }

  private switchLevel(id: string): void {
    if (id === this.level.id) return;
    if (this.demo) this.exitDemo();
    this.states.set(this.level.id, this.state);
    this.level = getLevel(id);
    this.state = this.states.get(id) ?? createGame(this.level);
    this.stencilId = this.level.stencils[0]!.id;
    this.orientation = this.orientationByStencil.get(this.stencilId) ?? { rotation: 0, flipped: false };
    this.orientationByStencil.set(this.stencilId, this.orientation);
    this.inkId = this.level.inks[0]!.id;
    this.pivot = { x: Math.floor(this.level.width / 2) - 1, y: Math.floor(this.level.height / 2) - 1 };
    this.hover = null;
    this.selected = null;
    this.pinned = false;
    this.mode = 'stamp';
    this.drawer.classList.remove('open');
    this.resize();
    this.render();
    this.toastMessage(`已换成「${this.level.name}」。`, 'info');
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    if (mode !== 'stamp') {
      this.pinned = false;
    }
    this.render();
    this.draw();
  }

  private movePivot(delta: Coord): void {
    if (this.demo) return;
    const x = Math.min(Math.max(this.pivot.x + delta.x, 0), this.level.width - 1);
    const y = Math.min(Math.max(this.pivot.y + delta.y, 0), this.level.height - 1);
    this.pivot = { x, y };
    this.hover = { x, y };
    this.pinned = false;
    if (this.mode !== 'stamp') this.mode = 'stamp';
    this.render();
    this.draw();
  }

  private rotate(): void {
    if (this.demo) return;
    this.orientation = rotateClockwise(this.orientation);
    this.orientationByStencil.set(this.stencilId, this.orientation);
    this.render();
    this.draw();
  }

  private flip(): void {
    if (this.demo) return;
    this.orientation = flipOrientation(this.orientation);
    this.orientationByStencil.set(this.stencilId, this.orientation);
    this.render();
    this.draw();
  }

  private cycleStencil(delta: number): void {
    const index = this.level.stencils.findIndex((s) => s.id === this.stencilId);
    const next = this.level.stencils[(index + delta + this.level.stencils.length) % this.level.stencils.length]!;
    this.selectStencil(next.id);
  }

  private selectStencil(id: string): void {
    this.stencilId = id;
    this.orientation = this.orientationByStencil.get(id) ?? { rotation: 0, flipped: false };
    this.render();
    this.draw();
  }

  private previewStatement(): string {
    const preview = previewStamp(this.level, this.state, this.currentRequest());
    if (!preview.canApply) return preview.reason ?? '当前不能盖印';
    return `本印 ${preview.cost} 格${inkName(this.level, this.inkId)}`;
  }

  private commitStamp(): void {
    if (this.demo) return;
    if (this.pinned) {
      this.toastMessage('预演已定格；先解除定格（P）再盖印。', 'info');
      return;
    }
    const result = stamp(this.level, this.state, this.currentRequest());
    if (!result.ok) {
      this.toastMessage(result.message, 'error');
      this.flashElement(this.inkList, 'shake');
      this.draw();
      return;
    }
    const wasFailed = result.game.status === 'failed';
    this.state = result.game;
    this.states.set(this.level.id, this.state);
    this.pinned = false;
    if (wasFailed) {
      const dirty = result.game.failure?.newCells ?? [];
      this.selected = dirty[0] ?? null;
      this.scrollInspectorIntoView();
      this.toastMessage(
        `第 ${result.entry.stampNo} 印落到保留格 ${dirty.map(cellLabel).join('、') || '（未知）'}，本次判失败。可撤回返还 ${result.entry.cost} 格墨。`,
        'error',
      );
    } else if (result.game.status === 'solved') {
      this.toastMessage(`完成！共用 ${result.game.stampNo} 印，${inkSummary(this.level, result.game.inkLeft)}。`, 'success');
    } else {
      const extras: string[] = [];
      if (result.entry.masked.length) extras.push(`挡墨 ${result.entry.masked.length} 格`);
      if (result.entry.offBoard.length) extras.push(`出界 ${result.entry.offBoard.length} 格`);
      this.toastMessage(
        `第 ${result.entry.stampNo} 印：消耗 ${result.entry.cost} 格${inkName(this.level, result.entry.ink)}${extras.length ? `（${extras.join(' · ')}不计费）` : ''}。`,
        'info',
      );
    }
    this.render();
    this.draw();
  }

  private scrollInspectorIntoView(): void {
    const card = this.inspector.closest('.card');
    if (!card) return;
    if (card.getBoundingClientRect().bottom <= window.innerHeight) return;
    window.setTimeout(() => {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  }

  private applyMask(cell: Coord): void {
    if (this.demo) return;
    const result = toggleMask(this.level, this.state, cell.x, cell.y);
    if (!result.ok) {
      this.toastMessage(result.message, 'error');
      return;
    }
    this.state = result.game;
    this.states.set(this.level.id, this.state);
    this.selected = cell;
    this.toastMessage(
      result.action.wasMasked ? `已收回 ${cellLabel(cell)} 的挡墨纸。` : `已给 ${cellLabel(cell)} 贴上挡墨纸。`,
      'info',
    );
    this.render();
    this.draw();
  }

  private doUndo(): void {
    if (this.demo) {
      this.pauseDemo(this.indexDemo(-1));
      return;
    }
    const result = undo(this.state);
    if (!result) {
      this.toastMessage('没有可撤回的操作。', 'info');
      return;
    }
    this.state = result.game;
    this.states.set(this.level.id, this.state);
    this.pinned = false;
    if (result.action.kind === 'stamp') {
      this.toastMessage(`已撤回第 ${result.action.stampNo} 印，返还 ${result.action.cost} 格${inkName(this.level, result.action.ink)}。`, 'success');
    } else {
      this.toastMessage(`已撤回 ${cellLabel(result.action)} 的挡墨纸操作。`, 'success');
    }
    this.render();
    this.draw();
  }

  private doReset(): void {
    if (this.demo) return;
    if (!this.resetArmed) {
      this.resetArmed = true;
      this.resetButton.classList.add('armed');
      this.resetButton.querySelector('span')!.textContent = '确认重置';
      window.setTimeout(() => {
        this.resetArmed = false;
        this.resetButton.classList.remove('armed');
        this.render();
      }, 2600);
      return;
    }
    this.resetArmed = false;
    this.resetButton.classList.remove('armed');
    this.state = createGame(this.level);
    this.states.set(this.level.id, this.state);
    this.selected = null;
    this.pinned = false;
    this.orientation = { rotation: 0, flipped: false };
    this.orientationByStencil.set(this.stencilId, this.orientation);
    this.pivot = { x: Math.floor(this.level.width / 2) - 1, y: Math.floor(this.level.height / 2) - 1 };
    this.render();
    this.draw();
    this.toastMessage('本关已重置。', 'info');
  }

  private defaultNotice(): string {
    if (this.mode === 'mask') return '挡墨纸模式：点击格子贴上或收回，不耗墨。';
    if (this.mode === 'inspect') return '查看模式：点击格子查看每一层墨的来源。';
    return TOUCH ? '轻点纸面定位模板，再按「盖印」落下。' : '移动鼠标预览孔位，点击纸面盖印；R 转动 · F 翻面。';
  }

  private toastMessage(message: string, tone: 'info' | 'success' | 'error'): void {
    this.toast.textContent = message;
    this.toast.title = message;
    this.toast.className = `toast show ${tone}`;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.className = 'toast';
      this.toast.textContent = this.defaultNotice();
      this.toast.title = '';
    }, tone === 'error' ? 6200 : 3800);
  }

  private refreshDefaultNotice(): void {
    if (this.toast.classList.contains('show')) return;
    this.toast.textContent = this.defaultNotice();
    this.toast.title = '';
  }

  private flashElement(node: HTMLElement, className: string): void {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
    window.setTimeout(() => node.classList.remove(className), 420);
  }

  private draw(): void {
    const demoAction = this.currentDemoStep()?.action;
    const demoStamp = demoAction?.kind === 'stamp' ? demoAction : null;
    const view: BoardView = {
      game: this.viewState,
      evaluation: this.evaluation,
      stencilId: demoStamp ? demoStamp.stencilId : this.stencilId,
      orientation: demoStamp ? demoStamp.orientation : this.orientation,
      pivot: demoStamp ? demoStamp.pivot : this.pivot,
      hover: this.demo ? null : this.hover,
      selected: this.demo ? null : this.selected,
      showPlan: this.showPlan,
      preview: this.demo ? null : this.preview,
      fillPreview: !this.demo && !!this.preview && (this.pinned || (this.mode === 'stamp' && this.hover !== null)),
      demoPreview: this.pinned,
      emphasizeErrors: this.pinned || this.viewState.status === 'failed',
      showPivot: !this.demo,
    };
    drawBoard(this.canvas, this.metrics, this.level, view);
    this.canvas.style.width = `${this.metrics.width}px`;
    this.canvas.style.height = `${this.metrics.height}px`;
    this.canvas.dataset.cell = String(this.metrics.cell);
    this.canvas.dataset.margin = String(this.metrics.margin);
    this.canvas.dataset.cols = String(this.level.width);
    this.canvas.dataset.rows = String(this.level.height);
    this.updatePreviewStrip();
  }

  private currentDemoStep(): StepResult | null {
    if (!this.demo || this.demo.index === 0) return null;
    return this.demo.run.steps[this.demo.index - 1] ?? null;
  }

  private updatePreviewStrip(): void {
    clear(this.previewStrip);
    if (this.demo) {
      const step = this.currentDemoStep();
      this.previewStrip.append(
        el(
          'div',
          { class: 'preview-strip-inner demo-strip' },
          el('span', { class: 'preview-title', text: step ? step.label : '准备开始演示' }),
          step
            ? el(
                'span',
                { class: 'preview-meta' },
                step.passed ? el('span', { class: 'ok', text: '✓ 检查通过' }) : el('span', { class: 'bad', text: '✗ 检查未通过' }),
                step.action?.kind === 'stamp' ? ` · 消耗 ${step.action.cost} 格` : '',
                step.preview ? ` · 预览 ${step.preview.cost} 格` : '',
              )
            : el('span', { class: 'preview-meta', text: '用下方控制逐步查看；不会改动你的进度。' }),
        ),
      );
      return;
    }
    if (this.mode === 'mask') {
      this.previewStrip.append(
        el(
          'div',
          { class: 'preview-strip-inner' },
          el('span', { class: 'preview-title', text: '挡墨纸模式' }),
          el('span', { class: 'preview-meta', text: '点击任意棋盘格贴上或收回挡墨纸；不消耗墨量。' }),
        ),
      );
      return;
    }
    if (this.mode === 'inspect') {
      this.previewStrip.append(
        el(
          'div',
          { class: 'preview-strip-inner' },
          el('span', { class: 'preview-title', text: '查看模式' }),
          el('span', { class: 'preview-meta', text: '点击棋盘格，在右侧查看每一层墨的来源。' }),
        ),
      );
      return;
    }
    const preview = previewStamp(this.level, this.state, this.currentRequest());
    const stencil = this.level.stencils.find((s) => s.id === this.stencilId)!;
    const inner = el('div', { class: 'preview-strip-inner' });
    inner.append(
      el(
        'span',
        { class: 'preview-title' },
        el('span', { class: 'stencil-mini-label', text: stencil.name }),
        el('span', { class: 'dot-sep', text: '·' }),
        inkDot(this.level, this.inkId),
        el('span', { text: inkName(this.level, this.inkId) }),
        el('span', { class: 'dot-sep', text: '·' }),
        el('span', { text: orientationLabel(this.orientation) }),
        this.pinned ? el('span', { class: 'pin-flag', text: '定格预演' }) : null,
      ),
    );
    const detail = el('span', { class: 'preview-meta' });
    detail.append(
      el('span', { class: preview.cost > 0 ? 'cost strong' : 'cost', text: `${preview.cost} 格` }),
      el('span', { text: `接触 · 挡墨 ${preview.masked.length} · 出界 ${preview.offBoard.length} · 余 ${preview.inkRemaining}` }),
    );
    if (preview.cleanContacts.length > 0) {
      detail.append(el('span', { class: 'bad', text: `会沾保留格 ${preview.cleanContacts.map(cellLabel).join('、')}` }));
    }
    inner.append(detail);
    if (!preview.canApply) {
      inner.append(el('span', { class: 'preview-warning', text: preview.reason ?? '' }));
    } else if (this.pinned) {
      inner.append(el('span', { class: 'preview-note', text: '本次仅是预演，不耗墨、不计入记录。' }));
    }
    this.previewStrip.append(inner);
  }

  private render(): void {
    this.renderLevelTabs();
    this.renderHead();
    this.renderInks();
    this.renderStencils();
    this.renderInspector();
    this.renderHistory();
    this.renderPlan();
    this.renderActions();
    this.renderDemoControls();
    this.refreshDefaultNotice();
    this.updatePreviewStrip();
    if (this.drawer.classList.contains('open')) this.renderDrawer();
  }

  private renderLevelTabs(): void {
    clear(this.levelTabs);
    for (const level of LEVELS) {
      const active = level.id === this.level.id;
      const button = el(
        'button',
        {
          class: `level-tab${active ? ' active' : ''}`,
          attrs: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false' },
          dataset: { level: level.id },
        },
        el('span', { class: 'level-index', text: String(LEVELS.indexOf(level) + 1).padStart(2, '0') }),
        el('span', { class: 'level-name', text: level.name }),
      );
      this.levelTabs.append(button);
    }
  }

  private renderHead(): void {
    this.levelTitle.textContent = this.level.name;
    this.levelSubtitle.textContent = this.level.subtitle;
    clear(this.boardStatus);
    const state = this.demo ? this.viewState : this.state;
    if (this.demo) {
      this.boardStatus.append(el('span', { class: 'status-chip demo', text: '演示中 · 不改动你的进度' }));
      return;
    }
    if (state.status === 'solved') {
      this.boardStatus.append(el('span', { class: 'status-chip solved', text: `完成 · ${state.stampNo} 印` }));
    } else if (state.status === 'failed') {
      this.boardStatus.append(el('span', { class: 'status-chip failed', text: `第 ${state.failure?.stampNo ?? '?'} 印失败` }));
    } else {
      this.boardStatus.append(el('span', { class: 'status-chip', text: `第 ${state.stampNo + 1} 印待盖` }));
    }
  }

  private renderActions(): void {
    const preview = this.preview;
    const inDemo = this.demo !== null;
    const can = !inDemo && this.mode === 'stamp' && !!preview?.canApply;
    this.stampButton.disabled = inDemo;
    this.stampButton.classList.toggle('ready', can);
    this.stampButton.title = preview?.reason ?? (preview ? `消耗 ${preview.cost} 格` : '盖印');
    (this.stampButton.querySelector('span') as HTMLSpanElement).textContent =
      this.mode === 'stamp' ? '盖印' : '切回盖印';
    this.pinButton.disabled = inDemo;
    this.pinButton.classList.toggle('active', this.pinned);
    this.pinButton.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
    (this.pinButton.querySelector('span') as HTMLSpanElement).textContent = this.pinned ? '解除预演' : '定格预演';
    this.undoButton.disabled = inDemo ? this.demoIndex === 0 : this.state.history.length === 0;
    this.undoButton.title = inDemo ? '演示回退一步' : undoLabel(this.level, this.state);
    this.resetButton.disabled = inDemo;
    if (!this.resetArmed) (this.resetButton.querySelector('span') as HTMLSpanElement).textContent = '重置';
    for (const mode of ['stamp', 'mask', 'inspect'] as Mode[]) {
      const button = this.modeButtons[mode];
      const active = this.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  private renderPlan(): void {
    clear(this.planProgress);
    const evaluation = this.evaluation;
    drawPlanThumbnail(this.planThumb, this.level, this.viewState.stampNo > 0 ? evaluation : undefined);
    const cleanTotal = this.level.plan.flat().filter((t) => t === 'clean').length;
    const dirty = evaluation.cleanViolations.length;
    const matched = evaluation.exactMatched;
    const total = evaluation.exactTotal;
    const bar = el('div', { class: 'progress-bar' }, el('span', { class: 'progress-fill' }));
    (bar.firstElementChild as HTMLSpanElement).style.width = `${total ? Math.round((matched / total) * 100) : 100}%`;
    this.planProgress.append(
      el('div', { class: 'progress-row' },
        el('span', { class: 'progress-label', text: '要求色' }),
        el('strong', { text: `${matched} / ${total}` }),
      ),
      bar,
      el('div', { class: 'progress-row' },
        el('span', { class: 'progress-label', text: '保留格' }),
        el('strong', { class: dirty ? 'bad' : 'good', text: dirty ? `${cleanTotal - dirty} / ${cleanTotal} 干净` : `${cleanTotal} / ${cleanTotal} 干净` }),
      ),
      el('div', { class: 'legend' },
        el('span', {}, el('i', { class: 'legend-swatch exact' }), '要求最终颜色'),
        el('span', {}, el('i', { class: 'legend-swatch clean' }), '必须干净'),
        el('span', {}, el('i', { class: 'legend-swatch free' }), '任意'),
      ),
    );

    clear(this.mixList);
    this.mixList.append(el('h4', { class: 'mix-title', text: '叠色笔记' }));
    for (const a of this.level.inks) {
      for (const b of this.level.inks) {
        if (a.id === b.id) continue;
        const result = mixColor(this.level, a.color, b.id);
        const reversed = mixColor(this.level, b.color, a.id);
        if (a.id > b.id && reversed === result) continue;
        const row = el('div', { class: 'mix-row' });
        row.append(
          inkDot(this.level, a.id),
          el('span', { class: 'mix-plus', text: '+' }),
          inkDot(this.level, b.id),
          el('span', { class: 'mix-arrow', text: '→' }),
          swatch(this.level, result, 22),
          el('span', { class: 'mix-name', text: colorName(this.level, result) }),
        );
        if (a.id < b.id && reversed !== result) {
          row.append(
            el('span', { class: 'mix-divider', text: '／倒序' }),
            swatch(this.level, reversed, 22),
            el('span', { class: 'mix-name', text: colorName(this.level, reversed) }),
          );
        }
        this.mixList.append(row);
      }
    }
    this.renderDiffs();
  }

  private renderDiffs(): void {
    clear(this.diffList);
    const evaluation = this.evaluation;
    const state = this.viewState;
    if (state.stampNo === 0) return;
    const wrong = evaluation.cells.filter(
      (cell) => (cell.requirement === 'exact' && !cell.exact) || cell.cleanViolated,
    );
    if (wrong.length === 0) {
      this.diffList.append(el('p', { class: 'diff-ok', text: '✓ 目前与样图一致。' }));
      return;
    }
    this.diffList.append(
      el('div', { class: 'diff-head' },
        el('span', { text: `差异 ${wrong.length} 格` }),
        el('span', { class: 'card-hint', text: '点格子查看来源' }),
      ),
    );
    const chips = el('div', { class: 'diff-chips' });
    const cleanWrong = wrong.filter((cell) => cell.cleanViolated).length;
    for (const cell of wrong.slice(0, 14)) {
      const target = cell.targetColor ? this.level.palette.find((p) => p.id === cell.targetColor) : null;
      const now = this.level.palette.find((p) => p.id === cell.currentColor);
      const chip = el(
        'button',
        {
          class: `diff-chip${cell.cleanViolated ? ' dirty' : ''}`,
          attrs: { type: 'button' },
          title: cell.cleanViolated
            ? `${cellLabel(cell)} 应保持干净，现为${now?.name ?? cell.currentColor}`
            : `${cellLabel(cell)} 应为${target?.name ?? cell.targetColor}，现为${now?.name ?? cell.currentColor}`,
          on: {
            click: () => {
              this.selected = { x: cell.x, y: cell.y };
              this.setMode('inspect');
            },
          },
        },
        el('span', { class: 'diff-coord', text: cellLabel(cell) }),
        el('span', { class: 'diff-symbol', text: cell.cleanViolated ? '✕' : (target?.symbol ?? '?') }),
      );
      chips.append(chip);
    }
    if (wrong.length > 14) chips.append(el('span', { class: 'diff-more', text: `+${wrong.length - 14}` }));
    this.diffList.append(chips);
    if (cleanWrong > 0) {
      this.diffList.append(el('p', { class: 'diff-note', text: `其中 ${cleanWrong} 格是必须保持干净的保留格。` }));
    }
  }

  private renderInks(): void {
    clear(this.inkList);
    const preview = this.preview;
    for (const ink of this.level.inks) {
      const remaining = this.viewState.inkLeft[ink.id] ?? 0;
      const isActive = ink.id === this.inkId;
      const cost = preview && preview.request.ink === ink.id && this.mode === 'stamp' ? preview.cost : null;
      const short = cost !== null && cost > remaining;
      const button = el(
        'button',
        {
          class: `ink-row${isActive ? ' active' : ''}${short ? ' short' : ''}`,
          attrs: { type: 'button', 'aria-pressed': isActive ? 'true' : 'false', disabled: this.demo !== null },
          on: { click: () => this.selectInk(ink.id) },
        },
        inkDot(this.level, ink.id),
        el('span', { class: 'ink-name', text: ink.name }),
        el('span', { class: 'ink-amount' }, el('strong', { text: String(remaining) }), el('span', { text: `/${this.level.budget[ink.id] ?? 0}` })),
        cost !== null ? el('span', { class: `ink-cost${short ? ' bad' : ''}`, text: `本印 ${cost}` }) : el('span', { class: 'ink-cost muted', text: '—' }),
      );
      this.inkList.append(button);
    }
    this.inkList.append(el('p', { class: 'ink-footnote', text: '同色叠盖也按格计费；顺序不同，混出的颜色可能不同。' }));
  }

  private selectInk(id: string): void {
    if (this.demo) return;
    this.inkId = id;
    this.pinned = false;
    this.render();
    this.draw();
  }

  private renderStencils(): void {
    clear(this.stencilList);
    const inDemo = this.demo !== null;
    const demoAction = this.currentDemoStep()?.action;
    const demoStamp = demoAction && demoAction.kind === 'stamp' ? demoAction : null;
    const shownOrientation = demoStamp ? demoStamp.orientation : this.orientation;
    const shownStencil = demoStamp ? demoStamp.stencilId : this.stencilId;
    for (const stencil of this.level.stencils) {
      const active = stencil.id === shownStencil;
      const button = el(
        'button',
        {
          class: `stencil-row${active ? ' active' : ''}`,
          attrs: { type: 'button', 'aria-pressed': active ? 'true' : 'false', disabled: inDemo },
          on: { click: () => this.selectStencil(stencil.id) },
        },
        (() => {
          const canvas = el('canvas', { class: 'stencil-icon' });
          const orientation = this.orientationByStencil.get(stencil.id) ?? { rotation: 0, flipped: false };
          drawStencilIcon(canvas, this.level, stencil.id, orientation);
          return canvas;
        })(),
        el('span', { class: 'stencil-text' }, el('strong', { text: stencil.name }), el('span', { class: 'stencil-count', text: `${stencil.holes.length} 孔` })),
      );
      this.stencilList.append(button);
    }

    clear(this.stencilControls);
    const active = this.level.stencils.find((s) => s.id === shownStencil)!;
    const label = el('span', { class: 'orient-label', text: orientationLabel(shownOrientation) });
    const rotate = el(
      'button',
      { class: 'btn small', attrs: { type: 'button', title: '顺时针转动 90° (R)' }, on: { click: () => this.rotate() } },
      icon('rotate'),
      el('span', { text: '转动' }),
      el('kbd', { text: 'R' }),
    );
    const flip = el(
      'button',
      { class: 'btn small', attrs: { type: 'button', title: '左右翻面 (F)' }, on: { click: () => this.flip() } },
      icon('flip'),
      el('span', { text: '翻面' }),
      el('kbd', { text: 'F' }),
    );
    rotate.disabled = inDemo;
    flip.disabled = inDemo;
    const note = active.note ? el('p', { class: 'stencil-note', text: active.note }) : null;
    this.stencilControls.append(el('div', { class: 'orient-row' }, label, rotate, flip), note ?? el('span'));
    const off = mapHoles(
      active,
      demoStamp ? demoStamp.pivot : this.pivot,
      demoStamp ? demoStamp.orientation : this.orientation,
    ).filter((h) => h.x < 0 || h.y < 0 || h.x >= this.level.width || h.y >= this.level.height);
    if (off.length) {
      this.stencilControls.append(el('p', { class: 'stencil-off', text: `当前定位有 ${off.length} 个孔落在纸外，出界孔不计墨。` }));
    }
  }

  private renderInspector(): void {
    clear(this.inspector);
    const selected = this.selected;
    if (!selected) {
      this.inspector.append(
        el('p', { class: 'empty-hint', text: '切到「查看」模式后点击棋盘格，这里会列出它从早到晚的每一层墨。' }),
      );
      const state = this.viewState;
      if (state.status === 'failed' && state.failure) {
        this.inspector.append(this.failureSummary(state.failure.newCells, state.failure.cells));
      }
      return;
    }
    const state = this.viewState;
    const idx = indexOf(this.level, selected.x, selected.y);
    const cell = state.cells[idx]!;
    const color = colorOfLayers(this.level, cell.layers);
    const requirement = this.level.plan[selected.y]![selected.x]!;
    const assessment = this.evaluation.cells[idx]!;
    const header = el(
      'div',
      { class: 'inspect-head' },
      swatch(this.level, color, 30),
      el('div', {},
        el('div', { class: 'inspect-coord', text: `${cellLabel(selected)} · ${colorName(this.level, color)}` }),
        el('div', { class: 'inspect-sub', text: cell.layers.length ? `${cell.layers.length} 层墨` : '仍是纸白' }),
      ),
      state.mask[idx] ? el('span', { class: 'tag mask-tag', text: '挡墨纸' }) : null,
    );
    this.inspector.append(header);

    let requirementText = '';
    if (requirement === 'clean') requirementText = '必须保持干净';
    else if (requirement === 'free') requirementText = '颜色不限';
    else requirementText = `要求最终颜色：${colorName(this.level, requirement)}`;
    const reqRow = el('div', { class: `inspect-req${assessment.cleanViolated || !assessment.exact ? ' bad' : ''}` },
      el('span', { text: requirementText }),
    );
    if (requirement !== 'free' && requirement !== 'clean' && color !== requirement) {
      reqRow.append(swatch(this.level, requirement, 18), el('span', { text: '当前不符' }));
    }
    if (assessment.cleanViolated) {
      reqRow.append(el('span', { class: 'bad', text: '已有墨' }));
    }
    this.inspector.append(reqRow);

    if (cell.layers.length === 0) {
      this.inspector.append(el('p', { class: 'empty-hint', text: '这一格还没有沾过墨。' }));
    } else {
      const list = el('ol', { class: 'layer-list' });
      const layers = [...cell.layers].reverse();
      for (const layer of layers) {
        const stencil = this.level.stencils.find((s) => s.id === layer.stencilId);
        const row = el(
          'li',
          { class: 'layer-row' },
          el('span', { class: 'layer-stamp', text: `#${layer.stampNo}` }),
          inkDot(this.level, layer.ink),
          el('span', { class: 'layer-main' },
            el('span', { class: 'layer-name', text: `${inkName(this.level, layer.ink)} · ${stencil?.name ?? layer.stencilId}` }),
            el('span', { class: 'layer-meta', text: `${orientationLabel(layer.orientation)} · 定位 ${cellLabel(layer.pivot)}` }),
          ),
        );
        row.title = layerSourceLabel(this.level, layer);
        list.append(row);
      }
      this.inspector.append(el('h4', { class: 'inspect-subtitle', text: '叠色来源（新 → 旧）' }), list);
      const chain = el('div', { class: 'color-chain' });
      chain.append(swatch(this.level, this.level.paperColor, 20));
      for (const layer of cell.layers) {
        chain.append(el('span', { class: 'mix-arrow', text: '+' }), inkDot(this.level, layer.ink));
      }
      chain.append(el('span', { class: 'mix-arrow', text: '=' }), swatch(this.level, color, 20), el('span', { class: 'mix-name', text: colorName(this.level, color) }));
      this.inspector.append(chain);
    }

    const maskButton = el(
      'button',
      { class: 'btn small ghost', attrs: { type: 'button' }, on: { click: () => this.applyMask(selected) } },
      icon('mask'),
      el('span', { text: state.mask[idx] ? '收回挡墨纸' : '贴上挡墨纸' }),
    );
    maskButton.disabled = this.state.status !== 'playing' || this.demo !== null;
    this.inspector.append(el('div', { class: 'inspect-actions' }, maskButton));

    if (state.status === 'failed' && state.failure) {
      this.inspector.append(this.failureSummary(state.failure.newCells, state.failure.cells));
    }
  }

  private failureSummary(newCells: Coord[], all: Coord[]): HTMLElement {
    const box = el('div', { class: 'failure-box' });
    box.append(
      el('div', { class: 'failure-title' }, icon('cross'), el('span', { text: '保留格被沾墨' })),
      el('p', { class: 'failure-text', text: `本次新弄脏 ${newCells.length} 格；图片上以红色实线标出。` }),
    );
    const chips = el('div', { class: 'failure-chips' });
    for (const cell of newCells) {
      chips.append(
        el('button', {
          class: 'chip-button',
          attrs: { type: 'button' },
          text: cellLabel(cell),
          on: {
            click: () => {
              this.selected = cell;
              this.setMode('inspect');
            },
          },
        }),
      );
    }
    box.append(chips);
    if (all.length > newCells.length) {
      box.append(el('p', { class: 'failure-text muted', text: `另有早先沾墨的保留格 ${all.length - newCells.length} 格。` }));
    }
    const undoBtn = el(
      'button',
      { class: 'btn small primary', attrs: { type: 'button' }, on: { click: () => this.doUndo() } },
      icon('undo'),
      el('span', { text: '撤回这一印' }),
    );
    box.append(undoBtn);
    return box;
  }

  private renderHistory(): void {
    clear(this.historyList);
    const state = this.viewState;
    if (this.demo) {
      this.historyList.append(
        el('li', { class: 'history-demo-note', text: `演示进行中（第 ${this.demo.index} / ${this.demo.run.steps.length} 步）。逐步明细见「操作串验证」，不会写入你的记录。` }),
      );
      return;
    }
    if (state.history.length === 0) {
      this.historyList.append(el('li', { class: 'history-empty', text: '还没有操作。每一印都会记在这里。' }));
      return;
    }
    for (const action of state.history) {
      if (action.kind === 'stamp') {
        const stencil = this.level.stencils.find((s) => s.id === action.stencilId);
        const row = el(
          'li',
          { class: `history-row${action.cleanContacts.length ? ' bad' : ''}` },
          el('span', { class: 'history-no', text: `#${action.stampNo}` }),
          inkDot(this.level, action.ink),
          el('span', { class: 'history-main' },
            el('span', { class: 'history-title', text: `${stencil?.name ?? action.stencilId} · ${orientationLabel(action.orientation)}` }),
            el('span', { class: 'history-meta', text: `${action.cost} 格${action.masked.length ? ` · 挡 ${action.masked.length}` : ''}${action.offBoard.length ? ` · 出界 ${action.offBoard.length}` : ''}${action.cleanContacts.length ? ` · 沾保留格 ${action.cleanContacts.length}` : ''}` }),
          ),
        );
        row.title = `定位 ${cellLabel(action.pivot)}`;
        this.historyList.append(row);
      } else {
        const row = el(
          'li',
          { class: 'history-row mask' },
          el('span', { class: 'history-no', text: '纸' }),
          el('span', { class: 'history-main' },
            el('span', { class: 'history-title', text: `${action.wasMasked ? '收回' : '贴上'}挡墨纸 ${cellLabel(action)}` }),
            el('span', { class: 'history-meta', text: '不耗墨' }),
          ),
        );
        this.historyList.append(row);
      }
    }
  }

  private openDrawer(): void {
    this.drawer.classList.add('open');
    this.renderDrawer();
    this.resize();
  }

  private closeDrawer(): void {
    this.drawer.classList.remove('open');
    this.resize();
  }

  private renderDrawer(): void {
    clear(this.drawerBody);
    clear(this.drawerFooter);
    const scripts = scriptsForLevel(this.level.id);
    if (scripts.length === 0) {
      this.drawerBody.append(el('p', { class: 'empty-hint', text: '本关还没有内置操作串。' }));
      return;
    }
    for (const script of scripts) {
      const run = this.demo && this.demo.script.id === script.id ? this.demo.run : runScript(this.level, script);
      const currentStepIndex = this.demo && this.demo.script.id === script.id ? this.demo.index - 1 : -1;
      const summary = el('div', { class: `verify-summary ${run.passed ? 'pass' : 'fail'}` });
      summary.append(
        el('div', { class: 'verify-title' },
          el('strong', { text: script.name }),
          el('span', { class: `verify-badge ${run.passed ? 'pass' : 'fail'}`, text: run.passed ? '全部通过' : '存在未通过' }),
        ),
        el('p', { class: 'verify-desc', text: script.description }),
        el('div', { class: 'verify-stats' },
          el('span', { text: `${script.steps.length} 步` }),
          el('span', { text: `盖印 ${run.state.stampNo} 次` }),
          el('span', { text: `最终 ${run.evaluation.solved ? '样图正确' : '样图未完成'}` }),
        ),
      );
      this.drawerBody.append(summary);

      const list = el('ol', { class: 'script-steps' });
      for (const step of run.steps) {
        const active = step.index === currentStepIndex;
        const row = el(
          'li',
          { class: `script-step ${step.passed ? 'pass' : 'fail'}${active ? ' active' : ''}` },
          el('span', { class: 'step-icon' }, icon(step.passed ? 'check' : 'cross')),
          el('span', { class: 'step-body' },
            el('span', { class: 'step-label', text: `${step.index + 1}. ${step.label}` }),
            el('span', { class: 'step-checks', text: step.checks.map((check) => check.label).join(' · ') }),
            step.checks.some((check) => !check.pass)
              ? el('span', { class: 'step-detail bad', text: step.checks.filter((check) => !check.pass).map((check) => check.detail).join(' / ') })
              : null,
          ),
          step.action?.kind === 'stamp' ? el('span', { class: 'step-cost', text: `${step.action.cost} 格` }) : null,
        );
        row.title = '点击从这一步开始演示';
        row.addEventListener('click', () => this.startDemo(script, step.index + 1, false));
        list.append(row);
      }
      this.drawerBody.append(list);

      const source = script.levelId === 'four-corner-flower' ? flowerSource : script.levelId === 'guarded-heart' ? heartSource : null;
      if (source) {
        const details = el('details', { class: 'ops-details' });
        const pre = el('pre', { class: 'ops-pre', text: source });
        const copyButton = el('button', { class: 'btn tiny ghost', attrs: { type: 'button' }, text: '复制操作串' });
        details.append(
          el('summary', {}, el('span', { text: '操作串原文' }), el('span', { class: 'card-hint', text: 'operations/*.ops.txt' })),
          pre,
          copyButton,
        );
        copyButton.addEventListener('click', () => {
          void navigator.clipboard
            .writeText(source)
            .then(() => {
              copyButton.textContent = '已复制';
            })
            .catch(() => {
              copyButton.textContent = '复制失败';
            })
            .finally(() => {
              window.setTimeout(() => {
                copyButton.textContent = '复制操作串';
              }, 1600);
            });
        });
        this.drawerBody.append(details);
      }

      if (!this.demo) {
        this.drawerFooter.append(
          el(
            'button',
            {
              class: 'btn primary',
              attrs: { type: 'button' },
              on: { click: () => this.startDemo(script, 0, true) },
            },
            icon('play'),
            el('span', { text: '在棋盘上逐步演示' }),
          ),
          el(
            'button',
            {
              class: 'btn ghost',
              attrs: { type: 'button' },
              on: { click: () => this.startDemo(script, run.steps.length, false) },
            },
            el('span', { text: '直接看最终结果' }),
          ),
        );
      }
    }
  }

  private startDemo(script: VerificationScript, index: number, play: boolean): void {
    if (this.demo) this.stopDemoTimer();
    this.closeDrawer();
    const run = runScript(this.level, script);
    this.demo = { script, run, index: Math.max(0, Math.min(index, run.steps.length)), playing: false, timer: null };
    this.mode = 'stamp';
    this.pinned = false;
    this.selected = null;
    this.demoBar.hidden = false;
    if (play) this.setDemoPlaying(true);
    this.render();
    this.draw();
    this.renderDrawer();
    this.toastMessage('演示在副本上进行，不会改动你的进度。', 'info');
  }

  private setDemoPlaying(playing: boolean): void {
    if (!this.demo) return;
    if (playing && this.demo.index === 0 && this.demo.run.steps.length > 0) {
      // 从第一步直接开始，避免演示以空棋盘停留一个节拍。
      this.demo.index = 1;
    }
    this.demo.playing = playing && this.demo.index < this.demo.run.steps.length;
    this.stopDemoTimer();
    if (this.demo.playing) {
      this.demo.timer = window.setTimeout(() => {
        if (!this.demo) return;
        this.demo.index = Math.min(this.demo.index + 1, this.demo.run.steps.length);
        if (this.demo.index >= this.demo.run.steps.length) {
          this.demo.playing = false;
        } else {
          this.setDemoPlaying(true);
        }
        this.afterDemoMove();
      }, DEMO_INTERVAL);
    }
    this.renderDemoControls();
  }

  private stopDemoTimer(): void {
    if (this.demo?.timer) {
      window.clearTimeout(this.demo.timer);
      this.demo.timer = null;
    }
  }

  private afterDemoMove(): void {
    // 演示会改变“当前视图状态”，因此整块面板都要重画，而不只是棋盘。
    this.render();
    this.draw();
  }

  private renderDemoControls(): void {
    if (!this.demo) {
      this.demoBar.hidden = true;
      return;
    }
    this.demoBar.hidden = false;
    const step = this.currentDemoStep();
    this.demoLabel.textContent = `${this.demo.index} / ${this.demo.run.steps.length}${step ? ` · ${step.label}` : ''}`;
    this.demoButtons.play.textContent = this.demo.playing ? '暂停' : this.demo.index >= this.demo.run.steps.length ? '重播' : '播放';
    this.demoButtons.prev.disabled = this.demo.index === 0;
    this.demoButtons.next.disabled = this.demo.index >= this.demo.run.steps.length;
  }

  private indexDemo(delta: number): number {
    if (!this.demo) return 0;
    this.demo.playing = false;
    this.stopDemoTimer();
    this.demo.index = Math.max(0, Math.min(this.demo.index + delta, this.demo.run.steps.length));
    return this.demo.index;
  }

  private pauseDemo(index: number): void {
    if (!this.demo) return;
    this.demo.index = Math.max(0, Math.min(index, this.demo.run.steps.length));
    this.demo.playing = false;
    this.stopDemoTimer();
    this.afterDemoMove();
    this.renderDemoControls();
  }

  private togglePlay(): void {
    if (!this.demo) return;
    if (this.demo.index >= this.demo.run.steps.length) {
      this.demo.index = 0;
    }
    this.setDemoPlaying(!this.demo.playing);
    this.afterDemoMove();
  }

  private exitDemo(): void {
    if (!this.demo) return;
    this.stopDemoTimer();
    this.demo = null;
    this.demoBar.hidden = true;
    this.render();
    this.draw();
    this.renderDrawer();
  }
}

function inkSummary(level: LevelDef, left: Record<string, number>): string {
  return level.inks.map((ink) => `${inkName(level, ink.id)}余 ${left[ink.id] ?? 0}`).join('，');
}

const mount = document.getElementById('app');
if (!mount) throw new Error('缺少 #app 挂载点');
new App(mount);
