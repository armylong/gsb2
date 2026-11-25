import { describe, expect, it } from 'vitest';
import { CATCHUP_MAX_RECOVERABLE_GAP_SEC } from '../src/core/config';
import { deriveState } from '../src/core/derive';
import { bothSequentialCues, primaryOnlyCues } from '../src/core/scenarios';
import type { Cue } from '../src/core/types';

const DURATION = 17.8;

function stateAt(cues: Cue[], time: number) {
  return deriveState({ cues, duration: DURATION, time });
}

describe('switch replay core', () => {
  it('switches primary drop to backup near the last good PTS and records delta', () => {
    const beforeDrop = stateAt(primaryOnlyCues(), 3.1);
    expect(beforeDrop.output).toBe('A');

    const confirming = stateAt(primaryOnlyCues(), 3.4);
    expect(confirming.output).toBe('A');
    expect(confirming.programState).toBe('confirming');

    const switched = stateAt(primaryOnlyCues(), 3.75);
    const failover = switched.switches.find(s => s.reason === 'primary-unavailable');
    expect(failover).toBeTruthy();
    expect(failover?.from).toBe('A');
    expect(failover?.to).toBe('B');
    expect(failover?.targetPts).toBeCloseTo(3.2, 1);
    // About 450ms of confirmation elapsed while B kept playing.
    expect(failover?.deltaBeforeMs ?? 0).toBeGreaterThan(350);
    expect(failover?.deltaBeforeMs ?? 0).toBeLessThan(650);
    expect(Math.abs(failover?.deltaAfterMs ?? 0)).toBeLessThan(1);
    expect(failover?.nearby).toBe(true);
    expect(switched.output).toBe('B');
  });

  it('does not flap and switches back only after stable primary recovery', () => {
    const full = stateAt(primaryOnlyCues(), DURATION);
    const failoverIndex = full.switches.findIndex(s => s.reason === 'primary-unavailable');
    const switchbackIndex = full.switches.findIndex(s => s.reason === 'recovery-primary');
    expect(failoverIndex).toBeGreaterThanOrEqual(0);
    expect(switchbackIndex).toBeGreaterThan(failoverIndex);

    const failover = full.switches[failoverIndex];
    const switchback = full.switches[switchbackIndex];
    expect(switchback.at - failover.at).toBeGreaterThan(5);
    expect(switchback.from).toBe('B');
    expect(switchback.to).toBe('A');

    // No repeated A/B alternation in this simple clip.
    const routes = full.switches.filter(s => s.to).map(s => s.to);
    expect(routes.filter(r => r === 'A').length).toBe(2); // startup + return
    expect(routes.filter(r => r === 'B').length).toBe(1);
  });

  it('handles sequential loss of both routes and simultaneous recovery with A priority', () => {
    const afterADrop = stateAt(bothSequentialCues(), 3.4);
    expect(afterADrop.output).toBe('B');

    const bothDown = stateAt(bothSequentialCues(), 7.3);
    expect(bothDown.output).toBeNull();
    expect(bothDown.programState).toBe('no-source');
    expect(bothDown.switches.some(s => s.reason === 'both-unavailable' && s.to === null)).toBe(true);

    const recovered = stateAt(bothSequentialCues(), 11.0);
    expect(recovered.output).toBe('A');
    const election = recovered.switches.find(s => s.reason === 'both-recovered-election');
    expect(election?.simultaneousRecovery).toBe(true);
    expect(election?.from).toBeNull();
    expect(election?.to).toBe('A');

    const end = stateAt(bothSequentialCues(), DURATION);
    expect(end.output).toBe('A');
    // Recovery does not cause a later B/A flap.
    expect(end.switches.filter(s => s.reason === 'both-recovered-election')).toHaveLength(1);
  });

  it('lock suppresses automatic failover until released', () => {
    const cues: Cue[] = [
      { id: 'lock-b', at: 1, kind: 'lock', lock: 'B' },
      { id: 'a-drop', at: 2, kind: 'health', route: 'A', health: 'offline' },
    ];
    const locked = stateAt(cues, 4);
    expect(locked.lock).toBe('B');
    expect(locked.output).toBe('B');

    const unlockCues: Cue[] = [
      ...cues,
      { id: 'unlock', at: 4.5, kind: 'lock', lock: 'auto' },
    ];
    const unlocked = stateAt(unlockCues, 5);
    expect(unlocked.lock).toBe('auto');
    // B is healthy and current, so unlock must not create a gratuitous switch.
    expect(unlocked.output).toBe('B');
  });

  it('locked bad route stays forced with explicit locked-bad state', () => {
    const cues: Cue[] = [
      { id: 'lock-a', at: 1, kind: 'lock', lock: 'A' },
      { id: 'a-drop', at: 2, kind: 'health', route: 'A', health: 'offline' },
    ];
    const state = stateAt(cues, 4);
    expect(state.output).toBe('A');
    expect(state.programState).toBe('locked-bad');
  });

  it('marks a too-large fast-forward gap as impossible to close in the operation window', () => {
    const cues: Cue[] = [
      { id: 'stall-a', at: 1, kind: 'health', route: 'A', health: 'stalled' },
      { id: 'resume-a', at: 1 + CATCHUP_MAX_RECOVERABLE_GAP_SEC + 1, kind: 'health', route: 'A', health: 'ok', recovery: 'ff' },
    ];
    const resumeTime = 1 + CATCHUP_MAX_RECOVERABLE_GAP_SEC + 1;
    const state = stateAt(cues, resumeTime + 0.1);
    const catchUp = state.sources.A.catchUp;
    expect(catchUp?.active).toBe(true);
    expect(catchUp?.impossible).toBe(true);
    expect(Math.abs(catchUp?.initialGapMs ?? 0)).toBeGreaterThan(CATCHUP_MAX_RECOVERABLE_GAP_SEC * 1000);
  });

  it('recomputes identical state when scrubbing back to the same time', () => {
    const cues = primaryOnlyCues();
    const first = stateAt(cues, 9.2);
    stateAt(cues, 12);
    const second = stateAt(cues, 9.2);
    expect(second.output).toBe(first.output);
    expect(second.switches.map(s => s.id)).toEqual(first.switches.map(s => s.id));
    expect(second.sources.A.pts).toBeCloseTo(first.sources.A.pts, 8);
    expect(second.sources.B.pts).toBeCloseTo(first.sources.B.pts, 8);
  });
});
