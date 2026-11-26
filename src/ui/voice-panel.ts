import type { VoiceName } from '../core/types';
import { store } from './state';
import { TIMBRE_OPTIONS } from './segment-panel';
import type { MetronomePlayer } from '../audio/player';

const VOICE_META: { name: VoiceName; label: string; hint: string }[] = [
  { name: 'downbeat', label: '重拍 (小节首拍)', hint: '●' },
  { name: 'beat', label: '普通拍', hint: '○' },
  { name: 'sub', label: '分拍', hint: '·' },
];

export class VoicePanel {
  readonly el: HTMLElement;

  constructor(private getPlayer: () => MetronomePlayer) {
    this.el = document.createElement('section');
    this.el.className = 'panel voice-panel';
    this.el.innerHTML = `
      <h2>音色与音量 (试听 / 导出共用)</h2>
      <label class="switch-row">
        <input type="checkbox" data-k="playSubdivisions" ${store.project.settings.playSubdivisions ? 'checked' : ''} />
        <span>播放分拍 (关闭后只听整拍; 导出跟随此开关)</span>
      </label>
      <div class="voice-list"></div>`;
    this.bind();
  }

  private get list(): HTMLElement {
    return this.el.querySelector('.voice-list')!;
  }

  private card(name: VoiceName, label: string, hint: string): string {
    const v = store.project.settings.voices[name];
    const disabled = name === 'sub' && !store.project.settings.playSubdivisions;
    return `<div class="voice-card ${disabled ? 'is-disabled' : ''}" data-voice="${name}">
      <header><span class="voice-hint voice-${name}">${hint}</span><span>${label}</span></header>
      <label class="field"><span>音量</span>
        <input type="range" min="0" max="1" step="0.01" data-k="volume" value="${v.volume}" />
        <em class="vol-readout">${Math.round(v.volume * 100)}</em>
      </label>
      <label class="field"><span>音色</span>
        <select data-k="timbre">
          ${TIMBRE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === v.timbre ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>音高 Hz</span>
        <input type="number" min="80" max="4000" step="0.01" data-k="pitch" value="${v.pitch}" />
      </label>
      <button type="button" class="btn btn-small" data-act="preview">试音</button>
    </div>`;
  }

  private bind(): void {
    this.el.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.dataset.k === 'playSubdivisions') {
        store.update((p) => {
          p.settings.playSubdivisions = (target as HTMLInputElement).checked;
        });
        // fullRender 会重建本面板 DOM; 阻止事件继续冒泡到已失效的委托链
        e.stopPropagation();
        return;
      }
      const card = target.closest('[data-voice]') as HTMLElement | null;
      const key = target.dataset.k;
      if (!card || !key) return;
      const name = card.dataset.voice as VoiceName;
      store.update((p) => {
        const voice = p.settings.voices[name];
        if (key === 'volume') voice.volume = Number(target.value);
        if (key === 'timbre') voice.timbre = target.value as typeof voice.timbre;
        if (key === 'pitch') voice.pitch = Number(target.value);
      });
      e.stopPropagation();
    });
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-act="preview"]') as HTMLElement | null;
      if (!btn) return;
      const card = btn.closest('[data-voice]') as HTMLElement;
      this.getPlayer().previewVoice(card.dataset.voice as VoiceName);
    });
  }

  render(): void {
    this.list.innerHTML = VOICE_META.map((m) => this.card(m.name, m.label, m.hint)).join('');
  }
}
