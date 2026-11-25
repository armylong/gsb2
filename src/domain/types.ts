export type Direction = 1 | -1;

export interface PointerEventRecord {
  seq: number;
  atMs: number;
  phase: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  sourceTime: number;
}

export interface ScrubAtom {
  id: string;
  /** Position on the rendered/exported route timeline, seconds. */
  at: number;
  /** Actual audible output duration after interruption/finalization. */
  duration: number;
  /** Original-buffer coordinate. Forward: start edge. Reverse: right edge. */
  sourceTime: number;
  direction: Direction;
  rate: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  jumped: boolean;
  note?: string;
}

export interface ScrubRoute {
  id: string;
  name: string;
  docId: string;
  createdAt: number;
  duration: number;
  atoms: ScrubAtom[];
  pointerEvents: PointerEventRecord[];
  validation?: boolean;
}

export interface ScrubOptions {
  durationSec: number;
  observationSec: number;
  sensitivity: number;
  throttleSec?: number;
}

export interface StartCommand {
  type: 'start';
  atom: ScrubAtom;
}

export interface StopCommand {
  type: 'stop';
  id: string;
  duration: number;
  fadeOut: number;
}

export type PlannerCommand = StartCommand | StopCommand;

export interface LogEntry {
  id: number;
  at: string;
  kind: 'pointer' | 'audio' | 'route' | 'file' | 'test' | 'error';
  message: string;
}

export interface AudioDoc {
  id: string;
  name: string;
  buffer: AudioBuffer;
  reversed: AudioBuffer;
  demo?: boolean;
}
