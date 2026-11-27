/// <reference path="types.ts" />
/// <reference path="transport.ts" />
namespace Adaptive {

  // ---------- 快速往返示例 ----------
  // 延迟均为距步骤起点的毫秒数, 目标段落写在每一步.
  interface ScenarioStep { delayMs: number; target: SectionId; label: string; }
  interface Scenario { name: string; desc: string; steps: ScenarioStep[]; }

  const SCENARIOS: Scenario[] = [
    {
      name: 'A. 连点覆盖(切换前改主意)',
      desc: '两次点击都发生在过门发声之前: 只有最新请求的过门播放, 旧过门标记 superseded 且永不发声.',
      steps: [
        { delayMs: 600, target: 'lively', label: '点「去热闹区」(bar 0 内, 过门排到 bar 1)' },
        { delayMs: 1400, target: 'calm', label: '过门发声前再点「回静区」(覆盖前请求)' },
      ],
    },
    {
      name: 'B. 过门中改道(请求并入)',
      desc: '过门已经开始才点新目标: 当前过门必须演完, 新请求标记 merged, 在下一次边界按新目标转换.',
      steps: [
        { delayMs: 600, target: 'lively', label: '点「去热闹区」(bar 1 静→闹过门)' },
        { delayMs: 3000, target: 'calm', label: 'bar 1 过门中再点「回静区」(并入, 不打断过门)' },
      ],
    },
    {
      name: 'C. 快速往返三次',
      desc: '快速来回点击: 被覆盖的请求不发声, 实际只听到两次转换; 日志可逐条回看预计/实际拍位.',
      steps: [
        { delayMs: 600, target: 'lively', label: '去热闹区' },
        { delayMs: 1100, target: 'calm', label: '马上回静区(覆盖上一条)' },
        { delayMs: 2600, target: 'lively', label: '再去热闹区(bar 2 内, 过门排到 bar 3)' },
      ],
    },
  ];

  const STATUS_LABEL: Record<RequestStatus, string> = {
    pending: '挂起',
    locked: '已锁定',
    effective: '已生效',
    superseded: '已覆盖',
    'same-target': '目标相同',
    merged: '并入当前过门',
    cleared: '已清理',
  };

  const KIND_LABEL: Record<BarKind, string> = {
    'main-calm': '静区主段',
    'main-lively': '热闹主段',
    'fill-c2l': '过门: 静→闹',
    'fill-l2c': '过门: 闹→静',
  };

  const SECTION_LABEL: Record<SectionId, string> = { calm: '静区', lively: '热闹区' };

  class App {
    private transport = new Transport();
    private $ = (id: string) => document.getElementById(id)!;
    private scenarioTimer: number | null = null;
    private knownRecords = 0;

    constructor() {
      this.transport.onRequestEvent(() => this.renderLog());
      this.bindControls();
      this.renderScenarios();
      this.renderLog();
      this.renderLoop();
    }

    private bindControls(): void {
      this.$('btn-play').addEventListener('click', () => { void this.transport.start(); });
      this.$('btn-pause').addEventListener('click', () => { void this.transport.pause(); });
      this.$('btn-resume').addEventListener('click', () => { void this.transport.resume(); });
      this.$('btn-reset').addEventListener('click', () => {
        this.stopScenario();
        this.transport.reset();
        this.knownRecords = 0;
        this.renderLog();
      });
      this.$('volume').addEventListener('input', (ev) => {
        this.transport.setVolume(Number((ev.target as HTMLInputElement).value) / 100);
      });
      this.$('btn-calm').addEventListener('click', () => this.transport.request('calm'));
      this.$('btn-lively').addEventListener('click', () => this.transport.request('lively'));
    }

    // ---------- 播放图 ----------
    private renderLoop(): void {
      const tick = () => {
        this.renderHud();
        this.renderTimeline();
        this.renderLog();
      };
      tick();
      window.setInterval(tick, 100);
    }

    private renderHud(): void {
      const t = this.transport;
      const beat = t.currentBeat();
      const bar = Math.floor(beat / BEATS_PER_BAR);
      const inBar = beat % BEATS_PER_BAR;
      const kind = t.kindAtBar(bar) ?? 'main-calm';
      const section = t.state.getCurrentSection();
      const pending = t.state.getPending();

      this.$('hud-beat').textContent = beat.toFixed(2);
      this.$('hud-bar').textContent = String(Math.max(0, bar));
      this.$('hud-inbar').textContent = inBar.toFixed(2);
      this.$('hud-section').textContent = SECTION_LABEL[section];
      this.$('hud-kind').textContent = KIND_LABEL[kind];
      this.$('hud-playing').textContent = t.isPlaying ? '播放中' : '已暂停/未开始';
      this.$('hud-section').className =
        'badge ' + (section === 'lively' ? 'badge-lively' : 'badge-calm');
      this.$('hud-kind').className =
        'badge ' + (isFill(kind) ? 'badge-fill' : section === 'lively' ? 'badge-lively' : 'badge-calm');

      // 界面区分: 普通挂起 vs 过门进行中的并入请求
      const modeEl = this.$('hud-mode');
      if (isFill(kind) && pending) {
        modeEl.textContent = `过门进行中 · 请求 #${pending.id} 已并入, 过门必须演完`;
        modeEl.className = 'mode mode-merged';
      } else if (pending && pending.plannedFillBar !== null) {
        modeEl.textContent =
          `挂起请求 #${pending.id}: bar ${pending.plannedFillBar} 边界(拍 ${pending.plannedFillBar * BEATS_PER_BAR})换段`;
        modeEl.className = 'mode mode-pending';
      } else {
        modeEl.textContent = '无挂起请求, 主段循环';
        modeEl.className = 'mode mode-idle';
      }

      // 拍点进度条
      const pct = (inBar / BEATS_PER_BAR) * 100;
      (this.$('beat-progress') as HTMLDivElement).style.width = `${pct}%`;

      const disabled = !t.isPlaying;
      ['btn-calm', 'btn-lively'].forEach((id) => {
        (this.$(id) as HTMLButtonElement).disabled = disabled;
      });
      this.$('pause-hint').textContent = disabled
        ? '暂停/未开始时场景按钮禁用: 先按播放或恢复, 保证点击拍位可解释'
        : '';
    }

    private renderTimeline(): void {
      const beat = this.transport.currentBeat();
      const curBar = Math.floor(beat / BEATS_PER_BAR);
      const startBar = Math.max(0, curBar - 3);
      const rows: string[] = [];
      const pending = this.transport.state.getPending();
      for (let b = startBar; b <= curBar + 4; b++) {
        const k = this.transport.kindAtBar(b);
        const isCurrent = b === curBar;
        const isFutureFill = pending !== null && pending.plannedFillBar === b;
        const cls = [
          'bar-cell',
          k === null ? 'bar-future' : isFill(k) ? 'bar-fill' : k === 'main-lively' ? 'bar-lively' : 'bar-calm',
          isCurrent ? 'bar-current' : '',
          isFutureFill && k === null ? 'bar-will-fill' : '',
        ].join(' ');
        const label = k === null
          ? (isFutureFill ? `bar ${b}\n(预计过门)` : `bar ${b}`)
          : `bar ${b}\n${KIND_LABEL[k]}`;
        rows.push(`<div class="${cls}">${label.replace('\n', '<br>')}</div>`);
      }
      this.$('timeline').innerHTML = rows.join('');
    }

    // ---------- 请求日志 ----------
    private renderLog(): void {
      const records = this.transport.state.getRecords();
      const body = this.$('log-body');
      if (records.length === 0) {
        body.innerHTML = '<tr><td colspan="8" class="muted">暂无请求 — 点击场景按钮或运行下方示例</td></tr>';
        this.knownRecords = 0;
        return;
      }
      const rows = records.map((r) => {
        const planned = r.plannedFillBar === null ? '—' : `bar ${r.plannedFillBar} / 拍 ${r.plannedFillBar * BEATS_PER_BAR}`;
        const actual = r.actualFillBar === null ? '—' : `bar ${r.actualFillBar} / 拍 ${r.actualFillBar * BEATS_PER_BAR}`;
        return `<tr class="row-${r.status}">
          <td>#${r.id}</td>
          <td>${r.origin === 'scenario' ? '示例' : '手动'}</td>
          <td>${SECTION_LABEL[r.sourceAtClick]} → ${SECTION_LABEL[r.target]}</td>
          <td>拍 ${r.clickBeat.toFixed(2)}<br><span class="muted">(bar ${r.clickBar})</span></td>
          <td>${planned}</td>
          <td>${actual}</td>
          <td><span class="status status-${r.status}">${STATUS_LABEL[r.status]}</span></td>
          <td class="note">${r.note}</td>
        </tr>`;
      });
      body.innerHTML = rows.join('');
      if (records.length > this.knownRecords) {
        const table = this.$('log-table');
        table.scrollTop = table.scrollHeight;
      }
      this.knownRecords = records.length;
    }

    // ---------- 快速往返示例 ----------
    private renderScenarios(): void {
      const wrap = this.$('scenarios');
      wrap.innerHTML = SCENARIOS.map((s, i) => `
        <div class="scenario">
          <div><b>${s.name}</b><br><span class="muted">${s.desc}</span></div>
          <div class="scenario-steps">${s.steps.map((st) =>
            `<span class="chip">+${(st.delayMs / 1000).toFixed(1)}s ${SECTION_LABEL[st.target]}</span>`).join('')}</div>
          <button id="scn-${i}">运行</button>
        </div>`).join('');
      SCENARIOS.forEach((s, i) => {
        this.$(`scn-${i}`).addEventListener('click', () => { void this.runScenario(s); });
      });
    }

    private stopScenario(): void {
      if (this.scenarioTimer !== null) {
        clearTimeout(this.scenarioTimer);
        this.scenarioTimer = null;
      }
      document.querySelectorAll<HTMLButtonElement>('[id^="scn-"]').forEach((b) => { b.disabled = false; });
      this.$('scenario-progress').textContent = '';
    }

    private async runScenario(s: Scenario): Promise<void> {
      this.stopScenario();
      // 示例要求干净起点: 从头开始后自动播放, 再按时间线发请求
      this.transport.reset();
      await this.transport.start();
      document.querySelectorAll<HTMLButtonElement>('[id^="scn-"]').forEach((b) => { b.disabled = true; });
      const progress = this.$('scenario-progress');
      const total = s.steps[s.steps.length - 1].delayMs + 4000;
      const t0 = performance.now();

      for (const step of s.steps) {
        await this.wait(step.delayMs - (performance.now() - t0));
        if (!this.transport.isPlaying) break; // 用户中途暂停/重置则中止示例
        this.transport.request(step.target, 'scenario');
        progress.textContent = `已执行: ${step.label}`;
      }
      const finishAt = performance.now() - t0;
      await this.wait(Math.max(0, total - finishAt));
      progress.textContent = '示例结束 — 可在日志表回看每条请求的预计/实际生效拍位';
      document.querySelectorAll<HTMLButtonElement>('[id^="scn-"]').forEach((b) => { b.disabled = false; });
      this.scenarioTimer = null;
    }

    private wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        this.scenarioTimer = window.setTimeout(() => resolve(), Math.max(0, ms));
      });
    }
  }

  window.addEventListener('DOMContentLoaded', () => new App());
}
