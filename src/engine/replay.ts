import type { Inputs, WindState } from './types';

/**
 * 录制内容是"操作序列 + 开局快照"，不录制结果。
 * 回放时用同一份物理重新模拟，所以换一个帆角就能做严格对照。
 */
export interface ReplayFrame {
  rudder: number;
  sheet: number;
}

export interface ReplaySnapshot {
  version: 1;
  wind: WindState;
  startPos: { x: number; y: number };
  startHeading: number;
  frames: ReplayFrame[];
  duration: number;
}

export class InputRecorder {
  private frames: ReplayFrame[] = [];
  private wind: WindState;
  private startPos: { x: number; y: number };
  private startHeading: number;
  private elapsed = 0;
  recording = false;

  constructor(wind: WindState, startPos: { x: number; y: number }, startHeading: number) {
    this.wind = { ...wind };
    this.startPos = { ...startPos };
    this.startHeading = startHeading;
  }

  begin(wind: WindState, startPos: { x: number; y: number }, startHeading: number): void {
    this.frames = [];
    this.elapsed = 0;
    this.wind = { ...wind };
    this.startPos = { ...startPos };
    this.startHeading = startHeading;
    this.recording = true;
  }

  record(input: Inputs, dt: number): void {
    if (!this.recording) return;
    this.frames.push({ rudder: input.rudder, sheet: input.sheet });
    this.elapsed += dt;
  }

  stop(): ReplaySnapshot {
    this.recording = false;
    return {
      version: 1,
      wind: { ...this.wind },
      startPos: { ...this.startPos },
      startHeading: this.startHeading,
      frames: this.frames,
      duration: this.elapsed,
    };
  }

  get length(): number {
    return this.frames.length;
  }
}

/**
 * 回放器：按帧吐出输入。
 * sheetMode='original' 用录制时的帆角；'fixed' 用统一覆盖值，
 * 这样同一场、同一套打舵可以对照不同帆角的结果。
 */
export class ReplayPlayer {
  private snap: ReplaySnapshot;
  private cursor = 0;

  constructor(snap: ReplaySnapshot) {
    this.snap = snap;
  }

  get snapshot(): ReplaySnapshot {
    return this.snap;
  }

  get done(): boolean {
    return this.cursor >= this.snap.frames.length;
  }

  get frameCount(): number {
    return this.snap.frames.length;
  }

  get index(): number {
    return this.cursor;
  }

  reset(): void {
    this.cursor = 0;
  }

  next(sheetMode: 'original' | 'fixed', fixedSheet: number): Inputs | null {
    if (this.done) return null;
    const f = this.snap.frames[this.cursor++];
    return {
      rudder: f.rudder,
      sheet: sheetMode === 'fixed' ? fixedSheet : f.sheet,
    };
  }
}
