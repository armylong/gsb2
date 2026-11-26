import { Timeline } from '../core/timeline';
import { MetronomePlayer, type PlayerState } from '../audio/player';
import { store } from './state';
import { BeatTable, type TableSelection } from './table';
import { SegmentPanel } from './segment-panel';
import { VoicePanel } from './voice-panel';
import { ExportPanel } from './export-panel';

export class App {
  private timeline: Timeline;
  private player: MetronomePlayer;
  private table: BeatTable;
  private segmentPanel: SegmentPanel;
  private voicePanel: VoicePanel;
  private exportPanel: ExportPanel;
  private selection: TableSelection | null = null;
  private loopSel: TableSelection | null = null;
  private lastBarIndex = -1;

  constructor() {
    this.timeline = new Timeline(store.project);
    this.player = new MetronomePlayer(this.timeline, () => store.project.settings);

    this.table = new BeatTable({
      getTimeline: () => this.timeline,
      getPlayer: () => this.player,
      getSelection: () => this.selection,
      onSelection: (sel) => {
        this.selection = sel;
        this.exportPanel.syncSelection(sel);
        this.table.render();
      },
      onLoop: (sel) => this.applyLoop(sel),
    });
    this.segmentPanel = new SegmentPanel();
    this.voicePanel = new VoicePanel(() => this.player);
    this.exportPanel = new ExportPanel(() => this.timeline, () => this.selection);

    this.mount();
    this.bindTransport();
    this.bindStore();
    this.player.subscribe((state) => this.onPlayerState(state));

    this.fullRender();
  }

  private mount(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = `
      <header class="topbar">
        <h1>拍点表 <small>多段拍号 / 变速 / 弱起 · 本地试听与 WAV 导出</small></h1>
        <div class="top-actions">
          <button type="button" class="btn" data-act="example">载入内置练习</button>
          <button type="button" class="btn" data-act="export-json">导出工程 JSON</button>
          <label class="btn btn-file">导入工程 JSON<input type="file" accept="application/json" hidden data-act="import-json" /></label>
        </div>
      </header>
      <section class="transport" data-role="transport">
        <button type="button" class="btn btn-primary" data-act="play">▶ 播放</button>
        <button type="button" class="btn" data-act="pause">⏸ 暂停</button>
        <button type="button" class="btn" data-act="stop">⏹ 停止</button>
        <label class="switch-row">
          <input type="checkbox" data-k="loop" />
          <span>循环框选区域</span>
        </label>
        <div class="position-readout" data-role="readout"></div>
      </section>
      <main class="layout">
        <div class="layout-main" data-role="table"></div>
        <aside class="layout-side">
          <div data-role="segments"></div>
          <div data-role="voices"></div>
          <div data-role="export"></div>
        </aside>
      </main>`;
    app.querySelector('[data-role="table"]')!.append(this.table.el);
    app.querySelector('[data-role="segments"]')!.append(this.segmentPanel.el);
    app.querySelector('[data-role="voices"]')!.append(this.voicePanel.el);
    app.querySelector('[data-role="export"]')!.append(this.exportPanel.el);
  }

  private bindTransport(): void {
    document.getElementById('app')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
      if (!btn) return;
      switch (btn.dataset.act) {
        case 'play':
          void this.player.play();
          break;
        case 'pause':
          this.player.pause();
          break;
        case 'stop':
          this.player.stop();
          break;
        case 'example':
          store.loadExample();
          this.selection = null;
          this.loopSel = null;
          (this.loopCheckbox() as HTMLInputElement).checked = false;
          this.player.clearLoop();
          break;
        case 'export-json':
          this.downloadJson();
          break;
      }
    });
    document.getElementById('app')!.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      // 面板内部控件已自行处理并拦截冒泡; 这里只管运输条的循环开关与文件导入
      if (target.dataset.k === 'loop') {
        this.loopSel = target.checked ? this.selection : null;
        this.applyLoop(this.loopSel);
        return;
      }
      const file = e.target as HTMLInputElement;
      if (file.dataset.act === 'import-json' && file.files?.length) {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            store.importJson(String(reader.result));
          } catch (err) {
            alert((err as Error).message);
          }
        };
        reader.readAsText(file.files[0]);
        file.value = '';
      }
    });
  }

  private loopCheckbox(): HTMLInputElement {
    return document.querySelector('[data-k="loop"]')!;
  }

  private applyLoop(sel: TableSelection | null): void {
    if (!sel) {
      this.player.clearLoop();
      return;
    }
    const q0 = this.timeline.bars[sel.barFrom].qStart;
    const q1 = this.timeline.bars[sel.barTo].qEnd;
    this.player.setLoop(q0, q1);
  }

  private bindStore(): void {
    // 初次渲染已在构造函数末尾手动完成; 之后每次工程变更都重建时间线并全量渲染
    store.subscribe(() => {
      // 保留播放头的 q (小节位置), 秒数由新时间线重算
      const next = new Timeline(store.project);
      const keepQ = Math.min(this.player.currentQ, next.totalQ);
      this.timeline = next;
      this.player.replaceTimeline(this.timeline, keepQ);
      if (this.loopSel) this.applyLoop(this.loopSel);
      this.fullRender();
    });
  }

  private fullRender(): void {
    this.table.render();
    this.segmentPanel.render();
    this.voicePanel.render();
  }

  private onPlayerState(state: PlayerState): void {
    this.table.updatePlayhead(state);
    const bar = this.timeline.bars[state.barIndex];
    const readout = document.querySelector('[data-role="readout"]')!;
    readout.innerHTML = `
      <span class="ro-item">小节 <b>${bar.isPickup ? '0(弱起)' : bar.barNumber}</b></span>
      <span class="ro-item">拍 <b>${state.beatInBar.toFixed(2)}</b></span>
      <span class="ro-item mono"><b>${state.t.toFixed(3)}</b> s</span>
      <span class="ro-item mono">q=${state.q.toFixed(3)}</span>`;
    if (state.playing && state.barIndex !== this.lastBarIndex) {
      this.lastBarIndex = state.barIndex;
      this.table.scrollToBar(state.barIndex);
    }
    if (!state.playing) this.lastBarIndex = -1;
  }

  private downloadJson(): void {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'beat-sheet-project.json';
    a.click();
    URL.revokeObjectURL(url);
  }
}
