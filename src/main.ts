import './ui/styles.css';
import { Engine } from './engine/engine.ts';
import {
  beatToMeasureBeat,
  beatToTime,
  buildChart,
  chartDuration,
  timeToBeat,
} from './engine/chart.ts';
import { deltaLabel } from './engine/judge.ts';
import type { Chart, ChartConfig, InputEvent, JudgementRow } from './engine/types.ts';
import {
  buildSampleChart,
  buildSampleInputs,
  normalizeLog,
  runReplay,
  SAMPLE_CONFIG,
  SAMPLE_TARGET_TEXT,
  TRIPLE_CONFIG,
  TRIPLE_TARGET_TEXT,
} from './engine/replay.ts';
import { Transport } from './audio/transport.ts';
import { Renderer } from './ui/renderer.ts';

const LANES = ['F', 'J'];

class App {
  private engine!: Engine;
  private transport!: Transport;
  private renderer!: Renderer;
  private raf = 0;
  private lastLogLen = 0;
  private replayMode = false;
  private expandedRows = new Set<number>();
  private audioCtx: AudioContext | null = null;
  /** 日志表只在条数/筛选/展开变化时重渲染，避免每帧重建 DOM。 */
  private lastLogRenderLen = -1;
  private lastLogFilter = '';

  // DOM 缓存
  private el = {} as Record<string, HTMLElement>;

  constructor() {
    this.buildDom();
    this.bindStaticControls();
    this.applyConfig(false);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ DOM 骨架

  private buildDom(): void {
    const root = document.getElementById('app')!;
    root.innerHTML = `
      <div class="panel" id="leftPanel"></div>
      <div class="center">
        <div class="hud">
          <div class="card"><div class="k">小节 / 拍</div><div class="v" id="hudBeat">– / –</div></div>
          <div class="card"><div class="k">歌曲时间</div><div class="v" id="hudTime">0.00s</div></div>
          <div class="card"><div class="k">成绩 P/G/M</div><div class="v" id="hudScore">0/0/0</div></div>
          <div class="card"><div class="k">命中率</div><div class="v" id="hudAcc">–</div></div>
        </div>
        <div id="deltaLine">用 F / J 键踩板（可按住），Space 暂停</div>
        <div id="stage">
          <canvas id="gameCanvas"></canvas>
          <div id="pauseOverlay">已 暂 停</div>
        </div>
      </div>
      <div class="panel" id="rightPanel"></div>`;

    document.getElementById('leftPanel')!.innerHTML = `
      <h2>规则参数</h2>
      <div class="row">
        <div><label>BPM</label><input id="inBpm" type="number" min="40" max="300" step="1" value="120"></div>
        <div><label>拍号</label><select id="inBeats"><option value="4">四拍 4/4</option><option value="3">三拍 3/4</option></select></div>
        <div><label>小节数</label><input id="inMeasures" type="number" min="1" max="16" step="1" value="4"></div>
      </div>
      <div class="row">
        <div><label>perfect 窗口 (ms)</label><input id="inPerfect" type="number" min="5" max="500" step="5" value="50"></div>
        <div><label>good 窗口 (ms)</label><input id="inGood" type="number" min="10" max="1000" step="10" value="120"></div>
      </div>

      <h2>地板排谱</h2>
      <textarea id="inTargets" rows="9"></textarea>
      <div class="help">每行：<code>轨, 拍[, 持续拍]</code>；持续拍 0=踩一下，&gt;0=按住（可跨小节）；# 注释</div>
      <div class="row" style="margin-top:6px">
        <button id="btnApply" class="primary">应用并重开</button>
        <button id="btnSample">载入样例</button>
        <button id="btnTriple">载入 3/4 预设</button>
      </div>
      <div id="chartError" style="color:var(--miss);font-size:11px"></div>

      <h2>节拍预览（程序合成）</h2>
      <div class="inline"><input type="checkbox" id="inMetro" checked><label for="inMetro" style="margin:0">节拍声</label></div>
      <div class="inline"><input type="checkbox" id="inHat"><label for="inHat" style="margin:0">半拍镲片（听细分）</label></div>
      <div class="inline"><input type="checkbox" id="inBlip" checked><label for="inBlip" style="margin:0">命中反馈音</label></div>
      <label>音量 <span class="pill" id="volVal">80%</span></label>
      <input id="inVol" type="range" min="0" max="1" step="0.05" value="0.8">

      <h2>手动音频偏移（只动声音，不动判定）</h2>
      <input id="inOffset" type="range" min="-200" max="200" step="5" value="0">
      <div class="pill" id="offsetVal">0 ms（声音相对画面）</div>

      <h2>练习控制</h2>
      <div class="row">
        <button id="btnPlay" class="primary">开始</button>
        <button id="btnPause">暂停</button>
        <button id="btnStop">归零</button>
      </div>
      <label>从第几小节重新练习</label>
      <div class="row">
        <select id="inSeek"></select>
        <button id="btnSeek" class="warn">跳转</button>
      </div>
      <div class="help">跳转/暂停时，未释放的按住按尾拍规则强制结算，规则见右侧说明</div>`;

    document.getElementById('rightPanel')!.innerHTML = `
      <h2>判定流水（可展开看候选归属）</h2>
      <div class="row">
        <select id="logFilter">
          <option value="all">全部</option>
          <option value="scored">只看结算</option>
          <option value="ignored">只看 ignored</option>
          <option value="overlap">只看重叠候选</option>
        </select>
        <button id="btnClearLog" class="fix">清空显示</button>
      </div>
      <div style="max-height:340px;overflow-y:auto">
        <table><thead><tr>
          <th>#</th><th>时刻</th><th>轨</th><th>板</th><th>判定</th><th>误差</th>
        </tr></thead><tbody id="logBody"></tbody></table>
      </div>

      <h2>可重放样例 / 帧率自检</h2>
      <div class="row">
        <select id="inFps">
          <option value="60">60 fps</option>
          <option value="30">30 fps</option>
          <option value="20">20 fps</option>
          <option value="10">10 fps</option>
        </select>
        <button id="btnReplay">跑样例重放</button>
      </div>
      <button id="btnSelftest" class="primary" style="width:100%">自检：60/30/20/10/7 fps 成绩是否逐行相同</button>
      <div id="selftest" style="margin-top:6px">尚未运行</div>

      <h2>规则速查</h2>
      <div class="help">
        ① 误差 Δ = 输入时刻 − 目标时刻，<b>负=早 正=晚</b>；|Δ| ≤ perfect 窗口 → perfect，
        ≤ good 窗口 → good，均为<b>闭区间，压线归优档</b>。<br>
        ② 窗口重叠时只在<b>同轨</b>候选里决胜：|Δ| 小者 → 更早拍位 → id；
        异轨板只入候选不可抢占；一次输入最多结算一块。<br>
        ③ 窗口内无本轨待判板 → <b>ignored</b>，不消耗任何板。<br>
        ④ 长按头/尾各判一次；跨尾拍未松手自动 perfect；
        暂停=按尾拍规则强制释放；跳小节=头拍在点后的板重置、跨越点的按住 miss 收尾。<br>
        ⑤ 所有判定基于绝对时间戳，与帧率无关。
      </div>`;

    [
      'inBpm', 'inBeats', 'inMeasures', 'inPerfect', 'inGood', 'inTargets', 'btnApply',
      'btnSample', 'btnTriple', 'chartError', 'inMetro', 'inHat', 'inBlip', 'inVol',
      'volVal', 'inOffset', 'offsetVal', 'btnPlay', 'btnPause', 'btnStop', 'inSeek',
      'btnSeek', 'hudBeat', 'hudTime', 'hudScore', 'hudAcc', 'deltaLine', 'gameCanvas',
      'pauseOverlay', 'logFilter', 'btnClearLog', 'logBody', 'inFps', 'btnReplay',
      'btnSelftest', 'selftest',
    ].forEach((id) => {
      this.el[id] = document.getElementById(id)!;
    });

    (this.el.inTargets as HTMLTextAreaElement).value = SAMPLE_TARGET_TEXT;
    this.renderer = new Renderer(this.el.gameCanvas as HTMLCanvasElement);
    this.renderer.resize();
    window.addEventListener('resize', () => this.renderer.resize());
  }

  // ------------------------------------------------------------ 配置 / 建引擎

  private readConfig(): ChartConfig {
    return {
      bpm: Number((this.el.inBpm as HTMLInputElement).value),
      beatsPerMeasure: Number((this.el.inBeats as HTMLSelectElement).value) as 3 | 4,
      measures: Number((this.el.inMeasures as HTMLInputElement).value),
      perfectWindow: Number((this.el.inPerfect as HTMLInputElement).value) / 1000,
      goodWindow: Number((this.el.inGood as HTMLInputElement).value) / 1000,
    };
  }

  private applyConfig(resetTransport: boolean): void {
    const cfg = this.readConfig();
    const text = (this.el.inTargets as HTMLTextAreaElement).value;
    const { chart, errors } = buildChart(cfg, text);
    this.el.chartError.textContent = errors.join('；');
    if (!chart) return;

    this.engine = new Engine(chart);
    this.lastLogLen = 0;
    this.lastLogRenderLen = -1;
    this.replayMode = false;

    if (!this.transport || resetTransport) {
      this.audioCtx ??= new AudioContext();
      if (this.transport) this.transport.stop();
      this.transport = new Transport(this.audioCtx, cfg, chartDuration(chart));
      this.transport.setVolume(Number((this.el.inVol as HTMLInputElement).value));
      this.transport.audioOffsetSec = Number((this.el.inOffset as HTMLInputElement).value) / 1000;
    } else {
      this.transport.setConfig(cfg, chartDuration(chart));
    }
    this.transport.metronomeOn = (this.el.inMetro as HTMLInputElement).checked;
    this.transport.subdivisionHats = (this.el.inHat as HTMLInputElement).checked;

    // 小节下拉
    const sel = this.el.inSeek as HTMLSelectElement;
    sel.innerHTML = '';
    for (let m = 0; m < cfg.measures; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = `第 ${m + 1} 小节`;
      sel.appendChild(opt);
    }
    this.renderer.flash = null;
  }

  // ------------------------------------------------------------ 控件绑定

  private bindStaticControls(): void {
    document.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).id;
      if (!id) return;
      switch (id) {
        case 'btnApply':
          this.applyConfig(true);
          break;
        case 'btnSample':
          this.loadPreset(SAMPLE_CONFIG, SAMPLE_TARGET_TEXT);
          break;
        case 'btnTriple':
          this.loadPreset(TRIPLE_CONFIG, TRIPLE_TARGET_TEXT);
          break;
        case 'btnPlay':
          void this.play();
          break;
        case 'btnPause':
          this.pause();
          break;
        case 'btnStop':
          this.stopAll();
          break;
        case 'btnSeek':
          this.seekMeasure();
          break;
        case 'btnReplay':
          this.runReplayOnce();
          break;
        case 'btnSelftest':
          this.runSelfTest();
          break;
        case 'btnClearLog':
          this.expandedRows.clear();
          this.lastLogRenderLen = -1;
          this.renderLog();
          break;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.transport.state === 'running') this.pause();
        else void this.play();
        return;
      }
      const lane = this.codeToLane(e.code);
      if (lane) this.feedInput('down', lane);
    });
    document.addEventListener('keyup', (e) => {
      const lane = this.codeToLane(e.code);
      if (lane) this.feedInput('up', lane);
    });

    // Canvas 点按也能踩（移动端/鼠标）：按纵向区域映射到轨
    const laneAtPointer = (clientY: number): string => {
      const rect = this.el.gameCanvas.getBoundingClientRect();
      return clientY - rect.top < rect.height / 2 ? 'F' : 'J';
    };
    this.el.gameCanvas.addEventListener('pointerdown', (e) => {
      this.feedInput('down', laneAtPointer(e.clientY));
    });
    this.el.gameCanvas.addEventListener('pointerup', (e) => {
      this.feedInput('up', laneAtPointer(e.clientY));
    });

    this.el.inMetro.addEventListener('change', () => {
      this.transport.metronomeOn = (this.el.inMetro as HTMLInputElement).checked;
    });
    this.el.inHat.addEventListener('change', () => {
      this.transport.subdivisionHats = (this.el.inHat as HTMLInputElement).checked;
    });
    this.el.inVol.addEventListener('input', () => {
      const v = Number((this.el.inVol as HTMLInputElement).value);
      this.transport?.setVolume(v);
      this.el.volVal.textContent = `${Math.round(v * 100)}%`;
    });
    this.el.inOffset.addEventListener('input', () => {
      const ms = Number((this.el.inOffset as HTMLInputElement).value);
      this.el.offsetVal.textContent = `${ms} ms（声音相对画面）`;
      this.transport?.setOffset(ms / 1000);
    });
    this.el.logFilter.addEventListener('change', () => this.renderLog());
  }

  private codeToLane(code: string): string | null {
    if (code === 'KeyF') return 'F';
    if (code === 'KeyJ') return 'J';
    return null;
  }

  private loadPreset(cfg: ChartConfig, text: string): void {
    (this.el.inBpm as HTMLInputElement).value = String(cfg.bpm);
    (this.el.inBeats as HTMLSelectElement).value = String(cfg.beatsPerMeasure);
    (this.el.inMeasures as HTMLInputElement).value = String(cfg.measures);
    (this.el.inPerfect as HTMLInputElement).value = String(cfg.perfectWindow * 1000);
    (this.el.inGood as HTMLInputElement).value = String(cfg.goodWindow * 1000);
    (this.el.inTargets as HTMLTextAreaElement).value = text;
    this.applyConfig(true);
  }

  // ------------------------------------------------------------ 传输控制

  private async play(): Promise<void> {
    if (this.replayMode) return;
    (this.el.pauseOverlay as HTMLElement).classList.remove('show');
    if (this.transport.state === 'paused') {
      this.engine.resume();
      this.transport.resume();
    } else {
      // stopped 或初次：引擎时间与传输一起从当前位置起跑
      await this.transport.start(this.engine.now);
    }
  }

  private pause(): void {
    if (this.transport.state !== 'running') return;
    const t = this.transport.pause();
    this.engine.pause(t); // 引擎按同一时刻清理按住
    (this.el.pauseOverlay as HTMLElement).classList.add('show');
    this.renderLog();
  }

  private stopAll(): void {
    this.transport.stop();
    this.applyConfig(false);
    (this.el.pauseOverlay as HTMLElement).classList.remove('show');
  }

  private seekMeasure(): void {
    const m = Number((this.el.inSeek as HTMLSelectElement).value);
    this.engine.seekToMeasure(m);
    this.transport.seek(beatToTime(m * this.engine.config.beatsPerMeasure, this.engine.config.bpm));
    if (this.transport.state === 'running') void this.transport.start(this.engine.now);
    this.renderer.flash = null;
    this.renderLog();
  }

  // ------------------------------------------------------------ 输入

  private feedInput(kind: InputEvent['kind'], lane: string): void {
    if (this.replayMode || this.transport.state !== 'running') return;
    const t = this.transport.currentSongTime();
    this.engine.queueInput({ t, kind, lane });
    this.engine.update(this.transport.currentSongTime());
    if (kind === 'down' && (this.el.inBlip as HTMLInputElement).checked) {
      const row = this.engine.log[this.engine.log.length - 1];
      this.transport.blip(row?.grade === 'perfect' || row?.grade === 'good');
    }
  }

  // ------------------------------------------------------------ 主循环

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.engine || !this.transport) return;

    if (this.transport.state === 'running' && !this.replayMode) {
      const t = this.transport.currentSongTime();
      this.engine.update(t);
      const stateAfter: string = this.transport.state;
      if (stateAfter === 'stopped') {
        (this.el.pauseOverlay as HTMLElement).textContent = '演 奏 结 束';
        (this.el.pauseOverlay as HTMLElement).classList.add('show');
      }
    }

    const now = this.engine.now;
    this.renderer.render(this.engine, now, LANES);
    this.updateHud(now);
    this.pickupNewJudgements(now);
    const filter = (this.el.logFilter as HTMLSelectElement).value;
    if (
      this.engine.log.length !== this.lastLogRenderLen ||
      filter !== this.lastLogFilter
    ) {
      this.renderLog();
    }
  }

  private pickupNewJudgements(now: number): void {
    if (this.engine.log.length === this.lastLogLen) return;
    for (let i = this.lastLogLen; i < this.engine.log.length; i++) {
      const row = this.engine.log[i];
      if (row.grade === 'ignored') continue;
      this.renderer.flash = { targetId: row.targetId, grade: row.grade, t: now };
    }
    this.lastLogLen = this.engine.log.length;
    // 误差行展示最新一条（含 ignored，提示“按多了/异轨不抢占”）
    this.updateDeltaLine(this.engine.log[this.engine.log.length - 1]);
  }

  private updateDeltaLine(row: JudgementRow): void {
    const el = this.el.deltaLine;
    if (row.deltaMs === null) {
      el.innerHTML = `<span class="badge ${row.grade}">${row.grade}</span> ${row.note ?? ''}`;
      return;
    }
    const ms = Math.round(row.deltaMs);
    const cls = ms === 0 ? 'edge' : ms < 0 ? 'early' : 'late';
    el.innerHTML = `<span class="badge ${row.grade}">${row.grade}</span>
      <span class="${cls}">${deltaLabel(row.deltaMs)}</span>
      （板 ${row.targetId ?? '–'} · ${row.kind}）`;
  }

  private updateHud(now: number): void {
    const cfg = this.engine.config;
    const beat = timeToBeat(now, cfg.bpm);
    const { measure, beatInMeasure } = beatToMeasureBeat(beat, cfg.beatsPerMeasure);
    this.el.hudBeat.textContent = `${Math.min(measure + 1, cfg.measures)} / ${Math.floor(beatInMeasure) + 1}`;
    this.el.hudTime.textContent = `${now.toFixed(2)}s`;
    const s = this.engine.summary();
    this.el.hudScore.textContent = `${s.perfect}/${s.good}/${s.miss}`;
    this.el.hudAcc.textContent = s.total ? `${Math.round((s.accuracy + Number.EPSILON) * 100)}%` : '–';
  }

  // ------------------------------------------------------------ 日志表

  private renderLog(): void {
    const filter = (this.el.logFilter as HTMLSelectElement).value;
    this.lastLogRenderLen = this.engine.log.length;
    this.lastLogFilter = filter;
    const body = this.el.logBody as HTMLTableSectionElement;
    const rows = this.engine.log.filter((r) => {
      if (filter === 'scored') return r.grade !== 'ignored';
      if (filter === 'ignored') return r.grade === 'ignored';
      if (filter === 'overlap') return (r.candidates?.length ?? 0) > 1;
      return true;
    });
    body.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.className = 'expandable';
      tr.innerHTML = `
        <td>${r.seq}</td>
        <td>${r.t.toFixed(3)}</td>
        <td>${r.lane}</td>
        <td>${r.targetId ?? '–'}${r.kind === 'tail' ? '·尾' : r.kind === 'head' ? '·头' : ''}</td>
        <td><span class="badge ${r.grade}">${r.grade}</span></td>
        <td>${r.deltaMs === null ? '–' : `${Math.round(r.deltaMs)}ms`}</td>`;
      tr.addEventListener('click', () => {
        if (this.expandedRows.has(r.seq)) this.expandedRows.delete(r.seq);
        else this.expandedRows.add(r.seq);
        this.renderLog();
      });
      body.appendChild(tr);

      if (this.expandedRows.has(r.seq)) {
        const detail = document.createElement('tr');
        detail.className = 'detail';
        const info: string[] = [];
        info.push(`来源: ${r.source}${r.note ? `；${r.note}` : ''}`);
        if (r.candidates?.length) {
          for (const c of r.candidates) {
            info.push(
              `候选 ${c.targetId}(${c.lane}轨,${c.part}) Δ=${Math.round(c.deltaMs)}ms ` +
                `${c.sameLane ? '同轨' : '异轨'} ${c.won ? '★赢家' : `落选:${c.reason ?? ''}`}`,
            );
          }
        }
        detail.innerHTML = `<td colspan="6">${info.join('<br>')}</td>`;
        body.appendChild(detail);
      }
    }
  }

  // ------------------------------------------------------------ 重放 / 自检

  private runReplayOnce(): void {
    const chart = buildSampleChart();
    const inputs = buildSampleInputs();
    const fps = Number((this.el.inFps as HTMLSelectElement).value);
    const engine = runReplay(chart, inputs, 1 / fps);
    this.engine = engine;
    this.replayMode = true;
    this.lastLogLen = engine.log.length;
    this.transport.pause();
    (this.el.pauseOverlay as HTMLElement).textContent = `重放完成 · ${fps}fps`;
    (this.el.pauseOverlay as HTMLElement).classList.add('show');
    this.renderer.flash = null;
    this.renderer.render(engine, engine.now, LANES);
    this.renderLog();
    const s = engine.summary();
    this.el.selftest.textContent =
      `重放 ${fps}fps：perfect ${s.perfect} / good ${s.good} / miss ${s.miss} / ignored ${s.ignored}\n` +
      `命中率 ${Math.round(s.accuracy * 100)}%（共 ${s.total} 条结算）`;
    this.el.selftest.className = 'ok';
  }

  private runSelfTest(): void {
    const chart = buildSampleChart();
    const inputs = buildSampleInputs();
    const base = normalizeLog(runReplay(chart, inputs, 1 / 60));
    const lines = ['基准 60fps 流水条数: ' + (base as unknown[]).length];
    let allOk = true;
    for (const fps of [30, 20, 10, 7]) {
      const got = normalizeLog(runReplay(chart, inputs, 1 / fps));
      const ok = JSON.stringify(got) === JSON.stringify(base);
      allOk &&= ok;
      const s = runReplay(chart, inputs, 1 / fps).summary();
      lines.push(
        `${fps}fps: ${ok ? '✓ 逐行相同' : '✗ 不一致'}  ` +
          `P${s.perfect}/G${s.good}/M${s.miss}/I${s.ignored} 命中率${Math.round(s.accuracy * 100)}%`,
      );
    }
    lines.push(allOk ? '\n结论：成绩与帧率无关，规则确定性成立。' : '\n结论：出现分歧，请检查引擎！');
    this.el.selftest.textContent = lines.join('\n');
    this.el.selftest.className = allOk ? 'ok' : 'fail';
  }
}

new App();
