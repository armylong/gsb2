export interface LayoutRefs {
  fileInput: HTMLInputElement;
  openButton: HTMLButtonElement;
  demoButton: HTMLButtonElement;
  exportDemoButton: HTMLButtonElement;
  fileName: HTMLElement;
  fileMeta: HTMLElement;
  playButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  timeReadout: HTMLElement;
  statusPill: HTMLElement;
  autoPlay: HTMLInputElement;
  waveform: HTMLCanvasElement;
  observation: HTMLInputElement;
  observationValue: HTMLOutputElement;
  sensitivity: HTMLInputElement;
  sensitivityValue: HTMLOutputElement;
  routeSelect: HTMLSelectElement;
  previewRouteButton: HTMLButtonElement;
  stopRouteButton: HTMLButtonElement;
  exportRouteButton: HTMLButtonElement;
  deleteRouteButton: HTMLButtonElement;
  clearRoutesButton: HTMLButtonElement;
  routeMeta: HTMLElement;
  routeWave: HTMLCanvasElement;
  recordEvents: HTMLInputElement;
  clearLogButton: HTMLButtonElement;
  downloadLogButton: HTMLButtonElement;
  logBox: HTMLElement;
  runTestsButton: HTMLButtonElement;
  testList: HTMLElement;
  audibleRoundTripButton: HTMLButtonElement;
  audibleBoundaryButton: HTMLButtonElement;
  playReferenceButton: HTMLButtonElement;
  toast: HTMLElement;
  dropOverlay: HTMLElement;
}

export function renderLayout(root: HTMLElement): LayoutRefs {
  root.innerHTML = `
    <div class="app">
      <header class="hero">
        <div>
          <h1>本地拖听工作台</h1>
          <p>打开短 WAV，在左右波形上按住往返拖动。正向/反向都播放对应位置的真实采样；停住、越界或远跳都会收声而不是循环响点。路线可试听并导出同一条时间路线的 WAV。</p>
        </div>
        <span class="badge">100% 本地 · 不上传服务器</span>
      </header>

      <main class="layout">
        <section class="stack">
          <div class="card">
            <div class="toolbar">
              <label class="button primary file-label" for="fileInput">打开短 WAV</label>
              <input id="fileInput" type="file" accept=".wav,audio/wav,audio/x-wav" />
              <button id="demoButton" class="button green" type="button">载入程序生成示例</button>
              <button id="exportDemoButton" class="button ghost" type="button" disabled>下载示例 WAV</button>
            </div>
            <div style="margin-top:10px">
              <div class="meta"><strong id="fileName">尚未载入音频</strong></div>
              <div class="meta" id="fileMeta">建议使用几分钟以内的立体声/单声道 16-bit PCM WAV；解码、波形和导出均在浏览器内完成。也可以直接把 WAV 拖进窗口。</div>
            </div>
          </div>

          <div class="card">
            <div class="toolbar" style="justify-content:space-between">
              <div class="transport">
                <button id="playButton" class="button primary" type="button" disabled>播放</button>
                <button id="stopButton" class="button" type="button" disabled>停止并回零</button>
                <span class="time-readout" id="timeReadout">0:00.000 / 0:00.000</span>
              </div>
              <span class="status-pill" id="statusPill">待载入</span>
            </div>
            <div class="wave-wrap">
              <canvas id="waveform" aria-label="左右声道波形，按住拖动进行 scrub"></canvas>
            </div>
            <div class="legend">
              <span><i class="swatch" style="background:#2563eb"></i>左声道 / 正向路线</span>
              <span><i class="swatch" style="background:#0891b2"></i>右声道</span>
              <span><i class="swatch" style="background:#ea580c"></i>反向路线</span>
              <span><i class="swatch" style="background:#16a34a"></i>内置节拍念拍音</span>
            </div>
            <p class="hint">操作：在波形上按住并左右拖动；拖得很慢会以短切片重叠听到当前位置，突然反向会立即切到镜像范围并真实倒放。松开鼠标后，默认从当前位置开始正常播放。快捷键：<span class="kbd">Space</span> 播放/暂停。</p>
          </div>

          <div class="card">
            <h2>⑥ 本地验证：往返定位与文件首尾跳跃</h2>
            <div class="button-row">
              <button id="runTestsButton" class="button primary" type="button">运行逻辑自检</button>
              <button id="audibleRoundTripButton" class="button orange" type="button" disabled>生成并试听往返路线 1s → 3s → 1s</button>
              <button id="audibleBoundaryButton" class="button orange" type="button" disabled>生成并试听边界跳跃路线</button>
              <button id="playReferenceButton" class="button green" type="button" disabled>顺序基准音</button>
            </div>
            <div id="testList" class="test-list"></div>
            <ol class="steps">
              <li>先点“顺序基准音”：内置示例每 0.5 秒是一拍，16 个替代念拍音按音高上行；检查正常播放是否连续。</li>
              <li>点“往返路线”：应先听到约第 3–7 拍上行，再听到对应内容倒序/倒放回来；不应混入正常连续播放。</li>
              <li>点“边界跳跃”：依次听到开头、结尾、右边缘短淡出、左边缘短淡入和开头；中间数秒不会被挤在一起补播。</li>
              <li>也可手动拖到 0 或结尾后继续往波形外拖，声音应在边缘平顺停止；松开后只启动一条正常播放声音。</li>
            </ol>
          </div>
        </section>

        <aside class="stack">
          <section class="card">
            <h2>拖听参数</h2>
            <div class="controls-grid">
              <div class="control">
                <label for="observation">观察长度 <output id="observationValue">0.32 s</output></label>
                <input id="observation" type="range" min="0.08" max="1.2" step="0.01" value="0.32" />
                <div class="help">停住或反向时保留多长的真实片段上下文。数值越小越聚焦响点，越大越容易听出乐句。</div>
              </div>
              <div class="control">
                <label for="sensitivity">速度灵敏度 <output id="sensitivityValue">1.00×</output></label>
                <input id="sensitivity" type="range" min="0.25" max="2" step="0.05" value="1" />
                <div class="help">影响快速拖动时的播放速率与响应。事件节流、声音数量上限和远跳截断会避免几秒内容挤进同一声。</div>
              </div>
              <label class="checkbox-row"><input id="autoPlay" type="checkbox" checked />松开后从当前位置正常播放</label>
            </div>
          </section>

          <section class="card">
            <h2>经过路线 / 导出 WAV</h2>
            <select id="routeSelect" class="select" size="5" aria-label="已录制路线"></select>
            <div class="button-row" style="margin-top:10px">
              <button id="previewRouteButton" class="button primary small" type="button" disabled>试听选中路线</button>
              <button id="stopRouteButton" class="button small" type="button" disabled>停止试听</button>
              <button id="exportRouteButton" class="button green small" type="button" disabled>导出同路线 WAV</button>
              <button id="deleteRouteButton" class="button ghost small" type="button" disabled>删除</button>
              <button id="clearRoutesButton" class="button ghost small" type="button" disabled>清空路线</button>
            </div>
            <p class="route-meta" id="routeMeta">拖动一次波形后，这里会出现该路线；试听和导出都由同一条 ScrubRoute 离线渲染。</p>
            <canvas id="routeWave" style="margin-top:10px" aria-label="路线渲染波形"></canvas>
          </section>

          <section class="card">
            <h2>事件记录</h2>
            <label class="checkbox-row"><input id="recordEvents" type="checkbox" checked />录制指针/音频事件（仅内存）</label>
            <div class="button-row" style="margin:10px 0">
              <button id="clearLogButton" class="button small" type="button">清空</button>
              <button id="downloadLogButton" class="button small" type="button">下载 JSON</button>
            </div>
            <div id="logBox" class="log" aria-live="polite"></div>
          </section>
        </aside>
      </main>
    </div>
    <div id="toast" class="toast"></div>
    <div id="dropOverlay" class="drop-overlay">松开以在本地打开 WAV</div>
  `;

  const get = <T extends Element>(selector: string): T => {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element as T;
  };

  return {
    fileInput: get<HTMLInputElement>('#fileInput'),
    openButton: get<HTMLButtonElement>('label[for="fileInput"]'),
    demoButton: get<HTMLButtonElement>('#demoButton'),
    exportDemoButton: get<HTMLButtonElement>('#exportDemoButton'),
    fileName: get('#fileName'),
    fileMeta: get('#fileMeta'),
    playButton: get<HTMLButtonElement>('#playButton'),
    stopButton: get<HTMLButtonElement>('#stopButton'),
    timeReadout: get('#timeReadout'),
    statusPill: get('#statusPill'),
    autoPlay: get<HTMLInputElement>('#autoPlay'),
    waveform: get<HTMLCanvasElement>('#waveform'),
    observation: get<HTMLInputElement>('#observation'),
    observationValue: get<HTMLOutputElement>('#observationValue'),
    sensitivity: get<HTMLInputElement>('#sensitivity'),
    sensitivityValue: get<HTMLOutputElement>('#sensitivityValue'),
    routeSelect: get<HTMLSelectElement>('#routeSelect'),
    previewRouteButton: get<HTMLButtonElement>('#previewRouteButton'),
    stopRouteButton: get<HTMLButtonElement>('#stopRouteButton'),
    exportRouteButton: get<HTMLButtonElement>('#exportRouteButton'),
    deleteRouteButton: get<HTMLButtonElement>('#deleteRouteButton'),
    clearRoutesButton: get<HTMLButtonElement>('#clearRoutesButton'),
    routeMeta: get('#routeMeta'),
    routeWave: get<HTMLCanvasElement>('#routeWave'),
    recordEvents: get<HTMLInputElement>('#recordEvents'),
    clearLogButton: get<HTMLButtonElement>('#clearLogButton'),
    downloadLogButton: get<HTMLButtonElement>('#downloadLogButton'),
    logBox: get('#logBox'),
    runTestsButton: get<HTMLButtonElement>('#runTestsButton'),
    testList: get('#testList'),
    audibleRoundTripButton: get<HTMLButtonElement>('#audibleRoundTripButton'),
    audibleBoundaryButton: get<HTMLButtonElement>('#audibleBoundaryButton'),
    playReferenceButton: get<HTMLButtonElement>('#playReferenceButton'),
    toast: get('#toast'),
    dropOverlay: get('#dropOverlay'),
  };
}
