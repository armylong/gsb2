// 场景状态的单一数据源。三维场景、UI 面板、音频引擎都订阅它，保证画面/状态/听感同源同步。
import { MAX_SOURCES, clamp, BOUNDS } from './spatial.js';

export const SOURCE_PRESETS = [
  { id: 's1', name: '声源 A · 脉冲', type: 'pulse', color: 0xff5d5d, position: { x: 4, y: 0, z: -3 } },
  { id: 's2', name: '声源 B · 和声', type: 'pad', color: 0x4dabff, position: { x: -4, y: 1, z: -2 } },
  { id: 's3', name: '声源 C · 颗粒', type: 'grain', color: 0xffc14d, position: { x: 0, y: 2, z: 4 } },
];

export const DEFAULT_LISTENER = { x: 0, y: 0, z: 0, yaw: 0 };

export function defaultState() {
  return {
    version: 0,
    listener: { ...DEFAULT_LISTENER },
    sources: SOURCE_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      color: p.color,
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      volume: 0.8,
      playing: false,
    })),
    // null 表示未进入独奏模式；否则为正在独奏的声源 id
    soloId: null,
    audioEnabled: false,
  };
}

export class Store {
  constructor(initial) {
    this.state = initial ?? defaultState();
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // 任何状态修改都走这一个入口；音频引擎与渲染层在同一个提交事件里拿到新值，避免画面与声音不同步
  update(mutator) {
    mutator(this.state);
    for (const fn of this.listeners) fn(this.state);
  }

  setListenerPosition(x, y, z) {
    this.update((s) => {
      s.listener.x = clamp(x, -BOUNDS.x, BOUNDS.x);
      s.listener.y = clamp(y, -BOUNDS.y, BOUNDS.y);
      s.listener.z = clamp(z, -BOUNDS.z, BOUNDS.z);
    });
  }

  setListenerYaw(yaw) {
    this.update((s) => {
      s.listener.yaw = yaw;
    });
  }

  setSourcePosition(id, x, y, z) {
    this.update((s) => {
      const src = s.sources.find((v) => v.id === id);
      if (!src) return;
      src.x = clamp(x, -BOUNDS.x, BOUNDS.x);
      src.y = clamp(y, -BOUNDS.y, BOUNDS.y);
      src.z = clamp(z, -BOUNDS.z, BOUNDS.z);
    });
  }

  setSourceVolume(id, volume) {
    this.update((s) => {
      const src = s.sources.find((v) => v.id === id);
      if (src) src.volume = clamp(volume, 0, 1);
    });
  }

  setPlaying(id, playing) {
    this.update((s) => {
      const src = s.sources.find((v) => v.id === id);
      if (src) src.playing = playing;
    });
  }

  togglePlaying(id) {
    this.update((s) => {
      const src = s.sources.find((v) => v.id === id);
      if (src) src.playing = !src.playing;
    });
  }

  // 独奏：只保留一个声源发声，其余静音但各自的播放/音量状态不被改写；再次独奏同一声源则退出
  setSolo(id) {
    this.update((s) => {
      s.soloId = s.soloId === id ? null : id;
    });
  }

  clearSolo() {
    this.update((s) => {
      s.soloId = null;
    });
  }

  setAudioEnabled(v) {
    this.update((s) => {
      s.audioEnabled = v;
    });
  }

  // 完整重置：位置、朝向、音量、播放、独奏全部回到初始
  reset() {
    const fresh = defaultState();
    fresh.audioEnabled = this.state.audioEnabled;
    this.update((s) => {
      s.version += 1; // 版本号通知 UI 强制回写数字输入框等非受控控件
      s.listener = fresh.listener;
      s.sources = fresh.sources;
      s.soloId = null;
    });
  }

  getSource(id) {
    return this.state.sources.find((v) => v.id === id);
  }
}

export { MAX_SOURCES };
