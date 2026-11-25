import { TIMELINE_DURATION_SEC } from '../core/config';
import { formatClock } from '../core/format';
import type { RouteId } from '../core/types';

export interface SourceRefs {
  card: HTMLElement;
  video: HTMLVideoElement;
  health: HTMLElement;
  pausedBadge: HTMLElement;
  actual: HTMLElement;
  pts: HTMLElement;
  gap: HTMLElement;
  rate: HTMLElement;
  stable: HTMLElement;
  playState: HTMLElement;
  catchup: HTMLElement;
  alignment: HTMLElement;
  buttons: Record<string, HTMLButtonElement>;
}

export interface LayoutRefs {
  app: HTMLElement;
  playBtn: HTMLButtonElement;
  restartBtn: HTMLButtonElement;
  scenarioButtons: Record<string, HTMLButtonElement>;
  lockButtons: Record<string, HTMLButtonElement>;
  timeline: HTMLInputElement;
  currentTime: HTMLElement;
  durationTime: HTMLElement;
  markers: HTMLElement;
  progress: HTMLElement;
  canvas: HTMLCanvasElement;
  onAirBadge: HTMLElement;
  banner: HTMLElement;
  bannerTitle: HTMLElement;
  bannerText: HTMLElement;
  programClock: HTMLElement;
  programMeta: HTMLElement;
  feedback: HTMLElement;
  sources: Record<RouteId, SourceRefs>;
  eventList: HTMLElement;
  detail: HTMLElement;
  detailBottom: HTMLElement;
  selfTest: HTMLElement;
}

function sourceCard(route: RouteId, title: string, subtitle: string, accent: string): string {
  return `
  <section class="panel source-card" data-source-card="${route}">
    <div class="source-head">
      <div class="source-title"><span class="route-dot ${route}"></span>${title}<span class="hint">${subtitle}</span></div>
      <span class="source-state ok" data-metric="health">正常</span>
    </div>
    <div class="source-video-wrap">
      <video data-video="${route}" muted playsinline preload="auto" crossorigin="anonymous"></video>
      <div class="source-overlay">
        <div></div>
        <div class="source-paused" data-metric="paused" hidden>已暂停 / 定格检查</div>
        <div></div>
      </div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="k">实测 currentTime</div><div class="v" data-metric="actual">0.000s</div></div>
      <div class="metric"><div class="k">核心 PTS / 帧</div><div class="v" data-metric="pts">0.000s · F0000</div></div>
      <div class="metric"><div class="k">与时间轴差</div><div class="v" data-metric="gap">+0ms</div></div>
      <div class="metric"><div class="k">rate / ready</div><div class="v" data-metric="rate">1× / 0</div></div>
      <div class="metric"><div class="k">连续稳定</div><div class="v" data-metric="stable">0.00s</div></div>
      <div class="metric"><div class="k">paused / seeking</div><div class="v" data-metric="playstate">paused</div></div>
      <div class="metric" style="grid-column: span 2"><div class="k">追赶 / 对齐</div><div class="v" data-metric="catchup">—</div></div>
    </div>
    <div class="source-actions">
      <button data-route="${route}" data-action="stall" class="warn">制造停顿</button>
      <button data-route="${route}" data-action="resume-ff" class="good">恢复·快进</button>
      <button data-route="${route}" data-action="drop" class="danger">模拟掉线</button>
      <button data-route="${route}" data-action="restore-seek">恢复·对齐</button>
      <button data-route="${route}" data-action="catchup">快进追赶</button>
      <button data-route="${route}" data-action="long-stall" class="warn">长停顿 8s</button>
    </div>
    <div class="metric"><div class="k">最近硬对齐</div><div class="v" data-metric="alignment" style="padding:8px 10px;">—</div></div>
    <div style="display:none" data-accent="${accent}"></div>
  </section>`;
}

export function createLayout(root: HTMLElement): LayoutRefs {
  root.innerHTML = `
    <div class="app">
      <header class="header">
        <div>
          <h1>主备信号切换回放器 <span class="pill">TypeScript · &lt;video&gt; · Canvas</span></h1>
          <div class="subtitle">
            A 主路（蓝色）与 B 备路（橙色）由 Canvas/MediaRecorder 生成，共享同一帧号/时间基准。所有掉线、停顿、快进和选举均为程序模拟。
          </div>
        </div>
        <div class="header-badges">
          <span class="pill">规则：确认故障 → 同 PTS 对齐 → 稳定防抖 → 主优先回切</span>
          <span class="pill" id="ready-pill">媒体生成资源加载中…</span>
        </div>
      </header>

      <div class="grid-top">
        <section class="panel panel-pad">
          <h2>节目输出 PROGRAM <span class="hint">Canvas 每帧绘制实际选中的 &lt;video&gt;</span></h2>
          <div class="program-monitor">
            <canvas id="program-canvas" width="1280" height="720"></canvas>
            <div class="monitor-overlay">
              <div class="monitor-top">
                <span class="onair" data-ref="onAirBadge">ON AIR · A</span>
                <span class="timecode" data-ref="programClock">TL 00:00.00 / PTS 0.000</span>
              </div>
              <div class="program-banner hidden" data-ref="banner">
                <div class="big" data-ref="bannerTitle">NO SIGNAL</div>
                <div class="small" data-ref="bannerText"></div>
              </div>
              <div class="monitor-bottom">
                <span class="timecode" data-ref="programMeta">等待媒体就绪</span>
              </div>
            </div>
          </div>
          <div class="feedback info" data-ref="feedback">正在加载两段本地生成视频…</div>
        </section>

        <aside class="panel panel-pad">
          <h2>脚本与导播控制</h2>
          <div class="control-group">
            <div class="control-label">内置故障片段</div>
            <div class="button-row">
              <button class="primary" data-scenario="primary-only">片段 1：仅主路掉线</button>
              <button class="primary" data-scenario="both-sequential">片段 2：先后两路掉线</button>
              <button data-scenario="manual">清空脚本</button>
            </div>
          </div>
          <div class="control-group">
            <div class="control-label">暂时锁定 / 取消</div>
            <div class="button-row">
              <button data-lock="auto" class="active">自动切换</button>
              <button data-lock="A">锁定 A</button>
              <button data-lock="B">锁定 B</button>
            </div>
            <div class="hint" style="margin-top:7px">锁定后即使该路故障也不自动逃走；取消锁定会立即按规则重新选举。</div>
          </div>
          <div class="control-group">
            <div class="control-label">选中切换的时间差证据</div>
            <div data-ref="detail"></div>
          </div>
        </aside>
      </div>

      <section class="panel panel-pad" style="margin-top:16px">
        <h2>回放时间轴与切换原因 <span class="hint">拖动会暂停并定位两路真实视频；再点播放可从该位置复现后续脚本</span></h2>
        <div class="transport">
          <button class="primary" data-ref="playBtn">▶ 播放</button>
          <button data-ref="restartBtn">↺ 回到开头</button>
          <input data-ref="timeline" type="range" min="0" max="${TIMELINE_DURATION_SEC}" step="0.01" value="0" aria-label="回放时间轴" />
          <span class="time-readout"><span data-ref="currentTime">00:00.00</span> / <span data-ref="durationTime">${formatClock(TIMELINE_DURATION_SEC)}</span></span>
        </div>
        <div class="timeline-wrap">
          <div class="timeline-track"><div class="timeline-progress" data-ref="progress" style="width:0%"></div></div>
          <div data-ref="markers"></div>
        </div>
      </section>

      <div class="sources">
        ${sourceCard('A', 'A 主路', 'PROGRAM', '#22d3ee')}
        ${sourceCard('B', 'B 备路', 'BACKUP', '#fb923c')}
      </div>

      <div class="bottom-grid">
        <section class="panel panel-pad">
          <h2>事件 / 切换流水 <span class="hint">点击任意条目跳到对应时刻</span></h2>
          <div class="event-list" data-ref="eventList"></div>
        </section>
        <section class="panel panel-pad">
          <h2>规则与稳定性状态</h2>
          <div data-ref="detailBottom"></div>
          <div class="rules">
            <strong>明确规则</strong>
            <ol>
              <li>掉线经 450ms 确认、停顿经 650ms 确认，避免瞬时抖动触发切换。</li>
              <li>故障切换以在播路最后有效 PTS 为目标；若备路偏离超过 160ms，执行 seek，并记录切换前后 Δ。</li>
              <li>恢复路默认 4× 快进追赶；差距超过 7.5s 时，预计无法在 2.5s 操作窗口内追上，界面明确告警。</li>
              <li>备路在播时，主路必须同步且稳定 1.15s，并满足 0.8s 切换保持窗才回切，防止来回切。</li>
              <li>同时恢复的并列选举：锁定路优先 → 当前在播路优先 → 固定主路 A 优先。</li>
            </ol>
          </div>
        </section>
      </div>

      <div class="footer-note">视频由 <code>scripts/generate-media.mjs</code> 调用本机 Chrome Canvas/MediaRecorder 生成；可重新运行 <code>npm run generate:media</code>。</div>
    </div>
    <div class="selftest" data-ref="selfTest" aria-live="polite"></div>
  `;

  const q = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
  const source = (route: RouteId): SourceRefs => {
    const card = q<HTMLElement>(`[data-source-card="${route}"]`);
    const metric = (name: string) => card.querySelector<HTMLElement>(`[data-metric="${name}"]`)!;
    const buttons: Record<string, HTMLButtonElement> = {};
    card.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => {
      buttons[button.dataset.action!] = button;
    });
    return {
      card,
      video: card.querySelector<HTMLVideoElement>('video')!,
      health: metric('health'),
      pausedBadge: metric('paused'),
      actual: metric('actual'),
      pts: metric('pts'),
      gap: metric('gap'),
      rate: metric('rate'),
      stable: metric('stable'),
      playState: metric('playstate'),
      catchup: metric('catchup'),
      alignment: metric('alignment'),
      buttons,
    };
  };

  return {
    app: q('.app'),
    playBtn: q('[data-ref="playBtn"]'),
    restartBtn: q('[data-ref="restartBtn"]'),
    scenarioButtons: Object.fromEntries(
      Array.from(root.querySelectorAll<HTMLButtonElement>('[data-scenario]')).map(b => [b.dataset.scenario!, b]),
    ),
    lockButtons: Object.fromEntries(
      Array.from(root.querySelectorAll<HTMLButtonElement>('[data-lock]')).map(b => [b.dataset.lock!, b]),
    ),
    timeline: q('[data-ref="timeline"]'),
    currentTime: q('[data-ref="currentTime"]'),
    durationTime: q('[data-ref="durationTime"]'),
    markers: q('[data-ref="markers"]'),
    progress: q('[data-ref="progress"]'),
    canvas: q<HTMLCanvasElement>('#program-canvas'),
    onAirBadge: q('[data-ref="onAirBadge"]'),
    banner: q('[data-ref="banner"]'),
    bannerTitle: q('[data-ref="bannerTitle"]'),
    bannerText: q('[data-ref="bannerText"]'),
    programClock: q('[data-ref="programClock"]'),
    programMeta: q('[data-ref="programMeta"]'),
    feedback: q('[data-ref="feedback"]'),
    sources: { A: source('A'), B: source('B') },
    eventList: q('[data-ref="eventList"]'),
    detail: q('[data-ref="detail"]'),
    detailBottom: q('[data-ref="detailBottom"]'),
    selfTest: q('[data-ref="selfTest"]'),
  };
}
