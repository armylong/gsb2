import { BONE_NAMES, getBoneSpec } from '../core/skeleton';
import type { BoneName, JointMask } from '../core/types';
import { MASK_PRESETS, type MaskPresetId } from '../core/mask';

export interface UiHandles {
  phaseA: HTMLElement;
  phaseB: HTMLElement;
  loopA: HTMLElement;
  loopB: HTMLElement;
  weight: HTMLElement;
  fadeDir: HTMLElement;
  root: HTMLElement;
  loopTotal: HTMLElement;
  playBtn: HTMLButtonElement;
  stepBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  timeScale: HTMLInputElement;
  timeScaleVal: HTMLElement;
  scrub: HTMLInputElement;
  scrubVal: HTMLElement;
  fadeB: HTMLButtonElement;
  fadeA: HTMLButtonElement;
  fadeDuration: HTMLInputElement;
  fadeDurationVal: HTMLElement;
  rootChk: HTMLInputElement;
  skeletonChk: HTMLInputElement;
  trajectoryChk: HTMLInputElement;
  jointSelect: HTMLSelectElement;
  jointPose: HTMLElement;
  demoDesc: HTMLElement;
  maskPresetRoot: HTMLElement;
  demoButtonRoot: HTMLElement;
  jointListRoot: HTMLElement;
}

export function getHandles(): UiHandles {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  return {
    phaseA: $('hud-phase-a'),
    phaseB: $('hud-phase-b'),
    loopA: $('hud-loop-a'),
    loopB: $('hud-loop-b'),
    weight: $('hud-weight'),
    fadeDir: $('hud-fade-dir'),
    root: $('hud-root'),
    loopTotal: $('hud-loop-total'),
    playBtn: $('btn-play'),
    stepBtn: $('btn-step'),
    resetBtn: $('btn-reset'),
    timeScale: $('inp-timescale'),
    timeScaleVal: $('val-timescale'),
    scrub: $('inp-scrub'),
    scrubVal: $('val-scrub'),
    fadeB: $('btn-fade-b'),
    fadeA: $('btn-fade-a'),
    fadeDuration: $('inp-fade'),
    fadeDurationVal: $('val-fade'),
    rootChk: $('chk-root'),
    skeletonChk: $('chk-skeleton'),
    trajectoryChk: $('chk-trajectory'),
    jointSelect: $('joint-select'),
    jointPose: $('joint-pose'),
    demoDesc: $('demo-desc'),
    maskPresetRoot: $('mask-presets'),
    demoButtonRoot: $('demo-buttons'),
    jointListRoot: $('joint-mask-list'),
  };
}

export interface MaskSlider {
  name: BoneName;
  input: HTMLInputElement;
  value: HTMLElement;
}

/** 构建遮罩预设按钮与逐关节滑杆 */
export function buildMaskControls(
  mask: JointMask,
  onPreset: (id: MaskPresetId) => void,
  onJoint: (name: BoneName, w: number) => void,
): { sliders: Map<BoneName, MaskSlider>; presetButtons: Map<MaskPresetId, HTMLButtonElement> } {
  const presetRoot = document.getElementById('mask-presets')!;
  const presetButtons = new Map<MaskPresetId, HTMLButtonElement>();
  for (const preset of MASK_PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => onPreset(preset.id));
    presetRoot.appendChild(btn);
    presetButtons.set(preset.id, btn);
  }

  const listRoot = document.getElementById('joint-mask-list')!;
  const sliders = new Map<BoneName, MaskSlider>();
  for (const name of BONE_NAMES) {
    const row = document.createElement('div');
    row.className = 'joint-row';
    const label = document.createElement('span');
    label.textContent = getBoneSpec(name).label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(mask.get(name) ?? 0);
    const val = document.createElement('span');
    val.className = 'w-val';
    val.textContent = input.value;
    input.addEventListener('input', () => {
      val.textContent = Number(input.value).toFixed(2);
      onJoint(name, Number(input.value));
    });
    row.append(label, input, val);
    listRoot.appendChild(row);
    sliders.set(name, { name, input, value: val });
  }
  return { sliders, presetButtons };
}

/** 同步所有遮罩滑杆到当前 mask（预设切换/重置时调用） */
export function syncMaskSliders(sliders: Map<BoneName, MaskSlider>, mask: JointMask): void {
  for (const name of BONE_NAMES) {
    const s = sliders.get(name)!;
    const w = mask.get(name) ?? 0;
    s.input.value = String(w);
    s.value.textContent = w.toFixed(2);
  }
}

/** 构建关节下拉框 */
export function buildJointSelect(onSelect: (name: BoneName | null) => void): HTMLSelectElement {
  const sel = document.getElementById('joint-select') as HTMLSelectElement;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— 请选择关节 —';
  sel.appendChild(placeholder);
  for (const name of BONE_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${getBoneSpec(name).label}（${name}）`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    onSelect(sel.value === '' ? null : (sel.value as BoneName));
  });
  return sel;
}
