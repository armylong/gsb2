import type { GameState } from './engine.js';

/**
 * Snapshot stack for undo. There is intentionally no redo stack:
 * a new action truncates the abandoned future by simply appending a fresh tip.
 */
export class History {
  private stack: GameState[];

  constructor(initial: GameState) {
    this.stack = [initial];
  }

  get current(): GameState {
    return this.stack[this.stack.length - 1]!;
  }

  get depth(): number {
    return this.stack.length;
  }

  get canUndo(): boolean {
    return this.stack.length > 1;
  }

  push(state: GameState): void {
    this.stack.push(state);
  }

  undo(): GameState | null {
    if (!this.canUndo) return null;
    this.stack.pop();
    return this.current;
  }

  reset(initial: GameState): void {
    this.stack = [initial];
  }
}
