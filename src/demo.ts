import type { DemoAction, Level } from './types';
import {
  groundFrame,
  pickupFrame,
  sweepPivot,
  sweepTranslate,
  sweepWalkPerson,
  type GameState,
  type StepResult,
} from './engine';

export interface DemoStepOutcome {
  state: GameState;
  ok: boolean;
  message: string;
  blocked: StepResult['block'] | null;
}

/** Applies one scripted demonstration instruction through the real move rules. */
export function runDemoAction(state: GameState, action: DemoAction, level: Level): DemoStepOutcome {
  switch (action.t) {
    case 'pivot': {
      const r = sweepPivot(state, action.who, action.delta, level);
      return { state: r.state, ok: r.reached, message: r.message, blocked: r.block };
    }
    case 'translate': {
      const r = sweepTranslate(state, action.dx, action.dy, level);
      return { state: r.state, ok: r.reached, message: r.message, blocked: r.block };
    }
    case 'walk': {
      const r = sweepWalkPerson(state, action.who, action.to, level);
      return { state: r.state, ok: r.reached, message: r.message, blocked: r.block };
    }
    case 'ground': {
      const r = groundFrame(state, level);
      return { state: r.state, ok: r.ok, message: r.message, blocked: null };
    }
    case 'pickup': {
      const r = pickupFrame(state, level);
      return { state: r.state, ok: r.ok, message: r.message, blocked: null };
    }
    case 'winWait':
      return { state, ok: true, message: action.say, blocked: null };
  }
}
