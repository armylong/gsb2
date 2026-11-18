// 右侧控制面板与顶部状态条。所有控件直接读写 Store，Store 提交后统一重渲染，
// 因此多声源同时播放时各自的按钮/音量条互不覆盖，重置时画面与状态一起恢复。
import { describeSpatial } from './spatial.js';

const fmt = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);

export class ControlPanel {
  constructor(store, audioEngine) {
    this.store = store;
    this.audio = audioEngine;
    this.root = document.getElementById('panel');
    this.statusEl = document.getElementById('audio-status');
    this.enableBtn = document.getElementById('enable-audio');
    this.resetBtn = document.getElementById('reset-scene');
    this.soloHint = document.getElementById('solo-hint');

    this.enableBtn.addEventListener('click', () => this.audio.enable());
    this.resetBtn.addEventListener('click', () => {
      this.store.reset();
    });

    this.store.subscribe((state) => this.render(state));
    this.audio.onStatus = (status) => this.renderStatus(status);
    this._lastVersion = this.store.state.version;
    this._buildSourceCards();
    this.render(this.store.state);
    this.renderStatus(this.audio.status);
  }

  renderStatus(status) {
    this.statusEl.dataset.kind = status.kind;
    this.statusEl.textContent = status.message;
    const enabled = status.kind === 'running' || status.kind === 'ready';
    this.enableBtn.disabled = enabled;
    this.enableBtn.textContent = enabled ? '声音已启用' : '启用声音';
  }

  _buildSourceCards() {
    const list = document.getElementById('source-list');
    list.innerHTML = '';
    this.store.state.sources.forEach((src) => {
      const card = document.createElement('section');
      card.className = 'source-card';
      card.dataset.testid = `card-${src.id}`;
      card.style.borderColor = `#${src.color.toString(16).padStart(6, '0')}`;
      card.innerHTML = `
        <header>
          <span class="dot" style="background:#${src.color.toString(16).padStart(6, '0')}"></span>
          <span class="card-title">${src.name}</span>
          <span class="spatial-tag" data-testid="tag-${src.id}"></span>
        </header>
        <div class="coord-row" data-testid="coord-${src.id}"></div>
        <div class="controls-row">
          <button type="button" class="play-btn" data-testid="play-${src.id}">▶ 播放</button>
          <button type="button" class="solo-btn" data-testid="solo-${src.id}">独奏</button>
        </div>
        <label class="volume-row">
          音量
          <input type="range" min="0" max="1" step="0.01" data-testid="vol-${src.id}" />
          <span class="vol-value" data-testid="volval-${src.id}"></span>
        </label>
      `;
      list.appendChild(card);

      card.querySelector(`[data-testid="play-${src.id}"]`).addEventListener('click', () => {
        this.store.togglePlaying(src.id);
      });
      card.querySelector(`[data-testid="solo-${src.id}"]`).addEventListener('click', () => {
        this.store.setSolo(src.id);
      });
      card.querySelector(`[data-testid="vol-${src.id}"]`).addEventListener('input', (e) => {
        this.store.setSourceVolume(src.id, Number(e.target.value));
      });
    });
  }

  _coordText(p) {
    return `x ${fmt(p.x)}　y ${fmt(p.y)}　z ${fmt(p.z)}`;
  }

  render(state) {
    const { listener, sources, soloId, audioEnabled } = state;

    document.getElementById('listener-coord').textContent = this._coordText(listener);
    document.getElementById('listener-yaw').textContent = `${listener.yaw.toFixed(1)}°`;
    document.getElementById('listener-yaw-note').textContent =
      `面向方位角 ${listener.yaw.toFixed(1)}°（0° 朝 -z，顺时针为正）`;

    // 听者坐标数字输入（聚焦时避免打断输入；重置版本变化时强制回写）
    const forceSync = state.version !== this._lastVersion;
    this._lastVersion = state.version;
    for (const axis of ['x', 'y', 'z']) {
      const input = document.getElementById(`listener-${axis}`);
      if (forceSync || document.activeElement !== input) input.value = listener[axis].toFixed(2);
    }
    const yawInput = document.getElementById('listener-yaw-input');
    if (forceSync || document.activeElement !== yawInput) yawInput.value = listener.yaw.toFixed(1);

    this.soloHint.hidden = soloId === null;
    if (soloId) {
      const src = sources.find((s) => s.id === soloId);
      this.soloHint.textContent = `独奏模式：仅「${src?.name ?? soloId}」发声，其他声源保持各自播放状态；再次点击「独奏」退出。`;
    }

    sources.forEach((src) => {
      const spatial = describeSpatial(src, listener);
      const tag = document.querySelector(`[data-testid="tag-${src.id}"]`);
      tag.textContent = `${spatial.label} · ${spatial.distance.toFixed(2)}m · 仰角${spatial.elevation.toFixed(0)}°`;

      document.querySelector(`[data-testid="coord-${src.id}"]`).textContent = this._coordText(src);

      const playBtn = document.querySelector(`[data-testid="play-${src.id}"]`);
      playBtn.textContent = src.playing ? '⏸ 暂停' : '▶ 播放';
      playBtn.classList.toggle('is-playing', src.playing);

      const soloBtn = document.querySelector(`[data-testid="solo-${src.id}"]`);
      soloBtn.classList.toggle('is-solo', soloId === src.id);
      soloBtn.textContent = soloId === src.id ? '退出独奏' : '独奏';
      soloBtn.disabled = !audioEnabled;

      const vol = document.querySelector(`[data-testid="vol-${src.id}"]`);
      if (document.activeElement !== vol) vol.value = src.volume;
      document.querySelector(`[data-testid="volval-${src.id}"]`).textContent = `${Math.round(src.volume * 100)}%`;

      const card = document.querySelector(`[data-testid="card-${src.id}"]`);
      card.classList.toggle('is-muted-by-solo', soloId !== null && soloId !== src.id && src.playing);
    });
  }

  bindNumericInputs(sceneView) {
    for (const axis of ['x', 'y', 'z']) {
      const input = document.getElementById(`listener-${axis}`);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        const l = this.store.state.listener;
        this.store.setListenerPosition(
          axis === 'x' ? value : l.x,
          axis === 'y' ? value : l.y,
          axis === 'z' ? value : l.z,
        );
      });
    }
    document.getElementById('listener-yaw-input').addEventListener('input', (e) => {
      const value = Number(e.target.value);
      if (Number.isFinite(value)) this.store.setListenerYaw(value);
    });
    document.getElementById('listener-turn-left').addEventListener('click', () => sceneView.rotateListener(-15));
    document.getElementById('listener-turn-right').addEventListener('click', () => sceneView.rotateListener(15));
  }
}
