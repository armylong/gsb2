import type { Goal, Pad, Rect, Vec } from './geom';

export const VIEW_W = 1000;
export const VIEW_H = 640;

/** Distance between the two handles. It must never change. */
export const HANDLE_DISTANCE = 180;
export const FRAME_LENGTH = 140;
export const FRAME_WIDTH = 30;
export const PORTER_RADIUS = 15;
export const PICKUP_RADIUS = 42;
export const STEP = 1.5;

export type DemoAction =
  | { t: 'pivot'; who: 0 | 1; delta: number; say: string }
  | { t: 'translate'; dx: number; dy: number; say: string }
  | { t: 'walk'; who: 0 | 1; to: Vec; say: string }
  | { t: 'ground'; say: string }
  | { t: 'pickup'; say: string }
  | { t: 'winWait'; say: string };

export interface Level {
  id: string;
  name: string;
  brief: string;
  walls: Rect[];
  pads: Pad[];
  goal: Goal;
  start: {
    h0: Vec;
    h1: Vec;
    grip?: [0 | 1, 0 | 1];
  };
  /** A repeatable legal route. The verifier executes exactly these actions. */
  demo: DemoAction[];
  /** A deliberately illegal far drag used by tests and the coaching panel. */
  trap:
    | { t: 'pivot'; who: 0 | 1; delta: number; expectSubject?: string; label: string }
    | { t: 'translate'; dx: number; dy: number; expectSubject?: string; label: string }
    | { t: 'walk'; who: 0 | 1; to: Vec; expectSubject?: string; label: string };
}
