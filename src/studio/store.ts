import { AnimationMachine } from '../engine/machine';
import { createDemoConfig, newEventId, newTransitionId } from '../engine/demo';
import { validateConfig } from '../engine/validate';
import {
  loadFromStorage,
  saveToStorage,
  serializeConfig,
  tryApplyConfig,
  tryApplyConfigText,
} from '../engine/config-store';
import { buildPreviewFrame } from '../engine/preview';
import type {
  AnimEvent,
  AnimState,
  MachineConfig,
  MachineSnapshot,
  Transition,
  TransitionConditions,
} from '../engine/types';

export const STEP_MS = 16;
export const TIME_SCALES = [1, 0.5, 0.25, 0.1] as const;

export type Mode = 'runtime' | 'preview';

export interface PreviewState {
  stateId: string;
  timeMs: number;
  playing: boolean;
}

export interface Notice {
  kind: 'ok' | 'error' | 'info';
  text: string;
  details?: string[];
}

export interface StudioSnapshot {
  config: MachineConfig;
  draft: MachineConfig;
  draftErrors: string[];
  draftWarnings: string[];
  dirty: boolean;
  machine: MachineSnapshot;
  mode: Mode;
  running: boolean;
  timeScale: number;
  preview: PreviewState;
  selectedStateId: string;
  selectedTransitionId: string | null;
  notice: Notice | null;
  configRevision: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function previewRange(config: MachineConfig, stateId: string): { max: number } {
  const state = config.states.find((s) => s.id === stateId) ?? config.states[0];
  if (!state) return { max: 1000 };
  return { max: state.loop ? state.durationMs * 3 : state.durationMs };
}

export class Studio {
  private listeners = new Set<() => void>();
  private snapshot: StudioSnapshot;
  private machine: AnimationMachine;
  private config: MachineConfig;
  private draft: MachineConfig;
  private draftErrors: string[] = [];
  private draftWarnings: string[] = [];
  private dirty = false;
  private mode: Mode = 'runtime';
  private running = false;
  private timeScale = 1;
  private preview: PreviewState;
  private selectedStateId: string;
  private selectedTransitionId: string | null = null;
  private notice: Notice | null = null;
  private configRevision = 0;

  private rafId: number | null = null;
  private lastFrame: number | null = null;
  private accumulator = 0;

  constructor(config: MachineConfig = createDemoConfig()) {
    this.config = config;
    this.draft = clone(config);
    this.machine = new AnimationMachine(config);
    this.selectedStateId = config.initialState;
    this.preview = { stateId: config.initialState, timeMs: 0, playing: false };
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): StudioSnapshot => this.snapshot;

  // ------------------------------------------------------------ runtime

  toggleRun(): void {
    if (this.mode !== 'runtime') return;
    this.running = !this.running;
    this.lastFrame = null;
    this.accumulator = 0;
    this.syncLoop();
    this.emit();
  }

  run(): void {
    if (this.mode !== 'runtime') return;
    this.running = true;
    this.lastFrame = null;
    this.accumulator = 0;
    this.syncLoop();
    this.emit();
  }

  pause(): void {
    this.running = false;
    this.syncLoop();
    this.emit();
  }

  reset(): void {
    this.machine.reset();
    this.running = false;
    this.accumulator = 0;
    this.lastFrame = null;
    this.preview = {
      stateId: this.machine.currentStateId,
      timeMs: 0,
      playing: false,
    };
    this.syncLoop();
    this.emit();
  }

  step(): void {
    if (this.mode === 'preview') {
      const { max } = previewRange(this.config, this.preview.stateId);
      const state = this.config.states.find((s) => s.id === this.preview.stateId);
      const next = this.preview.timeMs + STEP_MS;
      this.preview.timeMs = state?.loop ? next % max : Math.min(next, max);
      this.emit();
      return;
    }
    this.machine.update(STEP_MS);
    this.emit();
  }

  setTimeScale(scale: number): void {
    if (!TIME_SCALES.includes(scale as (typeof TIME_SCALES)[number])) return;
    this.timeScale = scale;
    this.emit();
  }

  setSpeed(value: number): void {
    this.machine.setSpeed(value);
    this.emit();
  }

  setHurt(value: boolean): void {
    this.machine.setHurt(value);
    this.emit();
  }

  queueAttack(): void {
    this.machine.queueAttack(1);
    this.emit();
  }

  clearAttacks(): void {
    this.machine.clearAttacks();
    this.emit();
  }

  // ------------------------------------------------------------ preview

  enterPreview(): void {
    const snap = this.machine.getSnapshot();
    this.running = false;
    this.mode = 'preview';
    this.preview = {
      stateId: this.selectedStateIdExists(snap.stateId) ? snap.stateId : this.config.states[0].id,
      timeMs: snap.elapsedMs,
      playing: false,
    };
    this.lastFrame = null;
    this.syncLoop();
    this.emit();
  }

  exitPreview(): void {
    this.mode = 'runtime';
    this.preview.playing = false;
    this.lastFrame = null;
    this.syncLoop();
    this.emit();
  }

  setPreviewState(stateId: string): void {
    if (!this.config.states.some((s) => s.id === stateId)) return;
    this.preview = { stateId, timeMs: 0, playing: this.preview.playing };
    this.selectedStateId = stateId;
    this.emit();
  }

  seekPreview(timeMs: number): void {
    const { max } = previewRange(this.config, this.preview.stateId);
    this.preview.timeMs = Math.min(max, Math.max(0, timeMs));
    this.emit();
  }

  togglePreviewPlay(): void {
    if (this.mode !== 'preview') return;
    this.preview.playing = !this.preview.playing;
    this.lastFrame = null;
    this.syncLoop();
    this.emit();
  }

  previewFrame() {
    return buildPreviewFrame(this.config, this.preview.stateId, this.preview.timeMs);
  }

  // ------------------------------------------------------------ selection

  selectState(stateId: string): void {
    if (!this.draft.states.some((s) => s.id === stateId)) return;
    this.selectedStateId = stateId;
    this.emit();
  }

  selectTransition(id: string | null): void {
    this.selectedTransitionId = id;
    if (id) {
      const transition = this.draft.transitions.find((t) => t.id === id);
      if (transition) this.selectedStateId = transition.from;
    }
    this.emit();
  }

  // ------------------------------------------------------------ draft editing

  patchState(stateId: string, patch: Partial<AnimState>): void {
    const state = this.draft.states.find((s) => s.id === stateId);
    if (!state) return;
    Object.assign(state, patch);
    this.draftChanged();
  }

  patchEvent(stateId: string, eventId: string, patch: Partial<AnimEvent>): void {
    const state = this.draft.states.find((s) => s.id === stateId);
    const event = state?.events.find((e) => e.id === eventId);
    if (!event) return;
    Object.assign(event, patch);
    this.draftChanged();
  }

  addEvent(stateId: string): void {
    const state = this.draft.states.find((s) => s.id === stateId);
    if (!state) return;
    const timeMs = Math.min(
      Math.max(0, Math.round(state.durationMs / 2)),
      Math.max(0, state.durationMs - 1),
    );
    state.events.push({
      id: newEventId(),
      name: '新事件',
      kind: 'marker',
      timeMs,
    });
    this.draftChanged();
  }

  removeEvent(stateId: string, eventId: string): void {
    const state = this.draft.states.find((s) => s.id === stateId);
    if (!state) return;
    state.events = state.events.filter((e) => e.id !== eventId);
    this.draftChanged();
  }

  patchTransition(id: string, patch: Partial<Omit<Transition, 'conditions'>>): void {
    const transition = this.draft.transitions.find((t) => t.id === id);
    if (!transition) return;
    Object.assign(transition, patch);
    this.draftChanged();
  }

  patchConditions(id: string, patch: Partial<TransitionConditions>): void {
    const transition = this.draft.transitions.find((t) => t.id === id);
    if (!transition) return;
    transition.conditions = { ...transition.conditions, ...patch };
    this.draftChanged();
  }

  addTransition(): void {
    const from = this.selectedStateId;
    const to = this.draft.states.find((s) => s.id !== from)?.id ?? from;
    const transition: Transition = {
      id: newTransitionId(),
      from,
      to,
      priority: 10,
      waitForProgress: false,
      progress: 0.5,
      conditions: {
        speed: null,
        hurt: null,
        attackTrigger: false,
      },
    };
    this.draft.transitions.push(transition);
    this.selectedTransitionId = transition.id;
    this.draftChanged();
  }

  removeTransition(id: string): void {
    this.draft.transitions = this.draft.transitions.filter((t) => t.id !== id);
    if (this.selectedTransitionId === id) this.selectedTransitionId = null;
    this.draftChanged();
  }

  patchConfigMeta(patch: Partial<Pick<MachineConfig, 'name' | 'initialState'>>): void {
    Object.assign(this.draft, patch);
    this.draftChanged();
  }

  private draftChanged(): void {
    this.dirty = true;
    const result = validateConfig(this.draft);
    this.draftErrors = result.errors;
    this.draftWarnings = result.warnings;
    this.emit();
  }

  // ------------------------------------------------------------ apply / IO

  applyDraft(): boolean {
    const result = tryApplyConfig(this.config, this.draft);
    if (!result.applied) {
      this.draftErrors = result.errors;
      this.draftWarnings = result.warnings;
      this.notice = {
        kind: 'error',
        text: '配置未应用: 校验失败，已保留原配置',
        details: result.errors,
      };
      this.emit();
      return false;
    }
    this.config = result.config;
    this.draft = clone(result.config);
    this.draftErrors = [];
    this.draftWarnings = result.warnings;
    this.dirty = false;
    this.machine = new AnimationMachine(this.config);
    this.running = false;
    this.mode = 'runtime';
    this.preview = {
      stateId: this.config.initialState,
      timeMs: 0,
      playing: false,
    };
    this.selectedStateId = this.config.initialState;
    this.selectedTransitionId = null;
    this.accumulator = 0;
    this.lastFrame = null;
    this.configRevision += 1;
    this.notice = {
      kind: 'ok',
      text: '配置已应用，状态机从确定初态重跑',
      details: result.warnings.length ? result.warnings : undefined,
    };
    this.syncLoop();
    this.emit();
    return true;
  }

  revertDraft(): void {
    this.draft = clone(this.config);
    this.draftErrors = [];
    this.draftWarnings = [];
    this.dirty = false;
    this.notice = { kind: 'info', text: '已撤销未应用的修改' };
    this.emit();
  }

  loadDemo(): void {
    this.draft = createDemoConfig();
    this.selectedStateId = this.draft.initialState;
    this.selectedTransitionId = null;
    const ok = this.applyDraft();
    if (ok) {
      this.notice = { kind: 'ok', text: '已恢复内置示例并重跑' };
      this.emit();
    }
  }

  importText(text: string): boolean {
    const result = tryApplyConfigText(this.config, text);
    if (!result.applied) {
      this.notice = {
        kind: 'error',
        text: '载入被拒绝: 配置无效，已保留已有配置',
        details: result.errors,
      };
      this.emit();
      return false;
    }
    this.draft = clone(result.config);
    this.draftErrors = [];
    this.draftWarnings = result.warnings;
    this.dirty = true;
    if (!this.draft.states.some((s) => s.id === this.selectedStateId)) {
      this.selectedStateId = this.draft.states[0]?.id ?? this.config.initialState;
    }
    this.selectedTransitionId = null;
    this.notice = {
      kind: 'ok',
      text: '文本已载入草稿，点击「应用」后生效',
      details: result.warnings.length ? result.warnings : undefined,
    };
    this.emit();
    return true;
  }

  draftText(): string {
    return serializeConfig(this.draft);
  }

  save(): void {
    const validation = validateConfig(this.draft);
    if (!validation.ok) {
      this.notice = {
        kind: 'error',
        text: '保存被拒绝: 配置无效，已保留已有配置',
        details: validation.errors,
      };
      this.emit();
      return;
    }
    const result = saveToStorage(storage(), this.draft);
    this.notice = result.ok
      ? { kind: 'ok', text: '配置已保存到本地存储' }
      : { kind: 'error', text: `保存失败: ${result.error}` };
    this.emit();
  }

  load(): void {
    const result = loadFromStorage(storage(), this.config);
    if (!result.applied) {
      this.notice = {
        kind: 'error',
        text: result.found ? '本地配置无效，已保留已有配置' : '载入失败',
        details: result.errors,
      };
      this.emit();
      return;
    }
    this.draft = clone(result.config);
    this.dirty = true;
    this.notice = {
      kind: 'info',
      text: '已从本地存储载入草稿，点击「应用」后生效',
      details: result.warnings.length ? result.warnings : undefined,
    };
    this.emit();
  }

  dismissNotice(): void {
    this.notice = null;
    this.emit();
  }

  // ------------------------------------------------------------ internals

  private selectedStateIdExists(id: string): boolean {
    return this.config.states.some((s) => s.id === id);
  }

  private shouldAnimate(): boolean {
    return (
      (this.mode === 'runtime' && this.running) ||
      (this.mode === 'preview' && this.preview.playing)
    );
  }

  private syncLoop(): void {
    if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
      return;
    }
    if (this.shouldAnimate() && this.rafId === null) {
      this.lastFrame = null;
      this.rafId = requestAnimationFrame(this.frame);
    } else if (!this.shouldAnimate() && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.lastFrame = null;
    }
  }

  private frame = (now: number): void => {
    this.rafId = null;
    const last = this.lastFrame ?? now;
    const realDt = Math.min(120, Math.max(0, now - last));
    this.lastFrame = now;

    if (this.mode === 'runtime' && this.running) {
      this.accumulator += realDt * this.timeScale;
      let guard = 0;
      while (this.accumulator >= STEP_MS && guard < 60) {
        this.machine.update(STEP_MS);
        this.accumulator -= STEP_MS;
        guard += 1;
      }
    } else if (this.mode === 'preview' && this.preview.playing) {
      const { max } = previewRange(this.config, this.preview.stateId);
      const state = this.config.states.find((s) => s.id === this.preview.stateId);
      const previewDt = realDt * this.timeScale;
      if (state?.loop) {
        this.preview.timeMs = (this.preview.timeMs + previewDt) % max;
      } else {
        const next = this.preview.timeMs + previewDt;
        if (next >= max) {
          this.preview.timeMs = max;
          this.preview.playing = false;
        } else {
          this.preview.timeMs = next;
        }
      }
    }

    this.rebuild();
    this.emit();

    if (this.shouldAnimate()) {
      this.rafId = requestAnimationFrame(this.frame);
    } else {
      this.lastFrame = null;
    }
  };

  private buildSnapshot(): StudioSnapshot {
    return {
      config: this.config,
      draft: this.draft,
      draftErrors: this.draftErrors,
      draftWarnings: this.draftWarnings,
      dirty: this.dirty,
      machine: this.machine.getSnapshot(),
      mode: this.mode,
      running: this.running,
      timeScale: this.timeScale,
      preview: { ...this.preview },
      selectedStateId: this.selectedStateId,
      selectedTransitionId: this.selectedTransitionId,
      notice: this.notice,
      configRevision: this.configRevision,
    };
  }

  private rebuild(): void {
    this.snapshot = this.buildSnapshot();
  }

  private emit(): void {
    this.rebuild();
    for (const listener of [...this.listeners]) listener();
  }
}

export const studio = new Studio();
