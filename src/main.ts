import './styles.css';
import { TIMELINE_DURATION_SEC } from './core/config';
import { clamp, formatClock } from './core/format';
import { cueId, cuesForScenario } from './core/scenarios';
import { deriveState } from './core/derive';
import type {
  Cue,
  Health,
  LockMode,
  RouteId,
  ScenarioId,
  SimState,
  SwitchEvidence,
} from './core/types';
import { VideoRig } from './media/VideoRig';
import { createLayout } from './ui/layout';
import { renderDetail, renderLists, updateHud } from './ui/render';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app root missing');
const refs = createLayout(root);

const duration = TIMELINE_DURATION_SEC;
let cues: Cue[] = cuesForScenario('primary-only');
let scenarioId: ScenarioId = 'primary-only';
let time = 0;
let playing = false;
let scrubbing = false;
let selectedSwitchId: string | null = 'sw-1';
let mediaReady = false;
let loadError: string | null = null;
let lastState: SimState | null = null;
let fullState: SimState = deriveState({ cues, duration, time: duration, scenarioId });
let detailSignature = '';
const evidence = new Map<string, SwitchEvidence>();

const rig = new VideoRig({ A: refs.sources.A.video, B: refs.sources.B.video }, refs.canvas);

function refreshLists(): void {
  // Switch ids are positional. Editing the cue set can renumber later records,
  // so old real-video evidence must not be rebound to a different switch.
  evidence.clear();
  fullState = deriveState({ cues, duration, time: duration, scenarioId });
  if (selectedSwitchId && !fullState.switches.some(record => record.id === selectedSwitchId)) {
    selectedSwitchId = 'sw-1';
  }
  renderLists(refs, cues, duration, selectedSwitchId);
  detailSignature = '';
}

function seekTo(at: number, autoPlay = false, switchId?: string): void {
  time = clamp(at, 0, duration);
  playing = autoPlay;
  scrubbing = false;
  if (switchId) selectedSwitchId = switchId;
  detailSignature = '';
}

function loadScenario(id: ScenarioId, autoPlay: boolean): void {
  scenarioId = id;
  cues = id === 'manual' ? [] : cuesForScenario(id);
  time = 0;
  playing = autoPlay;
  scrubbing = false;
  selectedSwitchId = 'sw-1';
  evidence.clear();
  detailSignature = '';
  refreshLists();
}

function addCue(cue: Cue): void {
  cues.push(cue);
  refreshLists();
}

type TimedCueInput =
  | { kind: 'health'; route: RouteId; health: Health; recovery?: 'ff' | 'seek'; label?: string }
  | { kind: 'lock'; lock: LockMode; label?: string }
  | { kind: 'align' | 'catchup'; route: RouteId; label?: string };

function addTimedCueAtCurrent(partial: TimedCueInput): void {
  const at = clamp(time, 0, duration - 0.05);
  if (partial.kind === 'lock') {
    addCue({ id: cueId('lock'), at, kind: 'lock', lock: partial.lock, label: partial.label });
  } else if (partial.kind === 'health') {
    addCue({
      id: cueId('health'),
      at,
      kind: 'health',
      route: partial.route,
      health: partial.health,
      recovery: partial.recovery,
      label: partial.label,
    });
  } else {
    addCue({ id: cueId(partial.kind), at, kind: partial.kind, route: partial.route, label: partial.label });
  }
}

refreshLists();

rig
  .load()
  .then(() => {
    mediaReady = true;
    const pill = document.querySelector<HTMLElement>('#ready-pill');
    if (pill) pill.textContent = '两段视频可播放 · 实际 video 状态已接入';
  })
  .catch((error: Error) => {
    loadError = error.message;
    const pill = document.querySelector<HTMLElement>('#ready-pill');
    if (pill) pill.textContent = '媒体加载失败';
  });

refs.playBtn.addEventListener('click', () => {
  if (time >= duration - 0.03) time = 0;
  playing = !playing;
});

refs.restartBtn.addEventListener('click', () => {
  seekTo(0, true);
});

Object.entries(refs.scenarioButtons).forEach(([id, button]) => {
  button.addEventListener('click', () => loadScenario(id as ScenarioId, id !== 'manual'));
});

Object.entries(refs.lockButtons).forEach(([lock, button]) => {
  button.addEventListener('click', () => {
    const current = deriveState({ cues, duration, time, scenarioId }).lock;
    if (current === lock) return;
    addTimedCueAtCurrent({
      kind: 'lock',
      lock: lock as LockMode,
      label: lock === 'auto' ? '取消锁定' : `锁定 ${lock} 路`,
    });
  });
});

refs.timeline.addEventListener('pointerdown', () => {
  scrubbing = true;
  playing = false;
});
refs.timeline.addEventListener('input', event => {
  time = Number((event.target as HTMLInputElement).value);
  scrubbing = true;
  playing = false;
});
refs.timeline.addEventListener('pointerup', () => {
  scrubbing = false;
});
refs.timeline.addEventListener('change', () => {
  scrubbing = false;
});

function handleTimelineActivation(element: HTMLElement): void {
  const target = element.closest<HTMLElement>('[data-at]');
  if (!target) return;
  const at = Number(target.dataset.at);
  const switchId = target.dataset.switchId || undefined;
  const selectedId = switchId ?? selectedSwitchId ?? undefined;
  seekTo(at, false, selectedId);
  if (switchId) selectedSwitchId = switchId;
}
refs.markers.addEventListener('click', event => handleTimelineActivation(event.target as HTMLElement));
refs.eventList.addEventListener('click', event => handleTimelineActivation(event.target as HTMLElement));

refs.detail.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-reproduce-at]');
  if (!button) return;
  seekTo(Number(button.dataset.reproduceAt), true, selectedSwitchId ?? undefined);
});

document.body.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  const route = button.dataset.route as RouteId;
  switch (button.dataset.action) {
    case 'stall':
      addTimedCueAtCurrent({ kind: 'health', route, health: 'stalled', label: `${route} 路手动停顿` });
      break;
    case 'drop':
      addTimedCueAtCurrent({ kind: 'health', route, health: 'offline', label: `${route} 路手动掉线` });
      break;
    case 'resume-ff':
      addTimedCueAtCurrent({ kind: 'health', route, health: 'ok', recovery: 'ff', label: `${route} 路恢复并快进` });
      break;
    case 'restore-seek':
      addTimedCueAtCurrent({ kind: 'health', route, health: 'ok', recovery: 'seek', label: `${route} 路恢复并对齐` });
      break;
    case 'catchup':
      addTimedCueAtCurrent({ kind: 'catchup', route, label: `${route} 路手动快进追赶` });
      break;
    case 'align':
      addTimedCueAtCurrent({ kind: 'align', route, label: `${route} 路手动对齐` });
      break;
    case 'long-stall': {
      // Keep the full 8s demonstration inside the media duration. If the
      // operator is already too late, move the playhead to the demo start.
      const startAt = Math.max(0, Math.min(time, duration - 8.1));
      if (time > startAt + 0.05) seekTo(startAt, false);
      addCue({ id: cueId('health'), at: startAt, kind: 'health', route, health: 'stalled', label: `${route} 路长停顿` });
      addCue({
        id: cueId('health'),
        at: startAt + 8,
        kind: 'health',
        route,
        health: 'ok',
        recovery: 'ff',
        label: `${route} 路长停顿后快进`,
      });
      refreshLists();
      break;
    }
  }
});

window.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return;
  if (event.code === 'Space') {
    event.preventDefault();
    playing = !playing;
  } else if (event.code === 'ArrowLeft') {
    seekTo(time - 1, false, selectedSwitchId ?? undefined);
  } else if (event.code === 'ArrowRight') {
    seekTo(time + 1, false, selectedSwitchId ?? undefined);
  }
});

function captureEvidence(prev: SimState | null, next: SimState, playbackActive: boolean): void {
  if (!playbackActive) return;
  const prevIds = new Set(prev?.switches.map(record => record.id) ?? []);
  for (const record of next.switches) {
    if (prevIds.has(record.id)) continue;
    if (Math.abs(record.at - next.time) > 0.16) continue;

    const targetPts = record.targetPts ?? next.time;
    if (!record.to) {
      evidence.set(record.id, {
        switchId: record.id,
        occurrences: (evidence.get(record.id)?.occurrences ?? 0) + 1,
        capturedAt: performance.now(),
        actualFromPts: record.from ? rig.videos[record.from].currentTime : null,
        actualToBefore: null,
        actualDeltaBeforeMs: null,
        actualToAfter: null,
        actualDeltaAfterMs: null,
        settled: true,
      });
      selectedSwitchId = record.id;
      continue;
    }

    const toVideo = rig.videos[record.to];
    const fromVideo = record.from ? rig.videos[record.from] : null;
    const actualToBefore = toVideo.currentTime;
    const ev: SwitchEvidence = {
      switchId: record.id,
      occurrences: (evidence.get(record.id)?.occurrences ?? 0) + 1,
      capturedAt: performance.now(),
      actualFromPts: fromVideo?.currentTime ?? null,
      actualToBefore,
      actualDeltaBeforeMs: (actualToBefore - targetPts) * 1000,
      actualToAfter: null,
      actualDeltaAfterMs: null,
      settled: false,
    };
    evidence.set(record.id, ev);
    selectedSwitchId = record.id;

    const to = record.to;
    let settled = false;
    const finishEvidence = (): void => {
      if (settled) return;
      settled = true;
      const current = evidence.get(record.id);
      if (!current) return;
      const video = rig.videos[to];
      current.actualToAfter = video.currentTime;
      current.actualDeltaAfterMs = (video.currentTime - targetPts) * 1000;
      // MP4 seek/decoder alignment can land on an adjacent frame; 350ms is
      // still far inside the visible "same content moment" neighborhood.
      current.settled = !video.seeking && Math.abs(current.actualDeltaAfterMs) < 350;
    };

    if (Math.abs(ev.actualDeltaBeforeMs ?? Number.POSITIVE_INFINITY) < 220) {
      ev.actualToAfter = actualToBefore;
      ev.actualDeltaAfterMs = ev.actualDeltaBeforeMs;
      ev.settled = true;
      settled = true;
    } else {
      toVideo.addEventListener('seeked', finishEvidence, { once: true });
      window.setTimeout(finishEvidence, 500);
    }
  }
}

interface ReplayDebugApi {
  version: string;
  getTime: () => number;
  isPlaying: () => boolean;
  isScrubbing: () => boolean;
  getCues: () => Cue[];
  getState: () => SimState | null;
  getActual: () => ReturnType<VideoRig['getActualStates']>;
  getEvidence: () => SwitchEvidence[];
  seek: (at: number, autoPlay?: boolean) => void;
  play: () => void;
  pause: () => void;
  loadScenario: (id: ScenarioId, autoPlay?: boolean) => void;
  addCue: (cue: Cue) => void;
  formatClock: (t: number) => string;
}

declare global {
  interface Window {
    __switchReplay?: ReplayDebugApi;
  }
}

window.__switchReplay = {
  version: '1.0.0',
  getTime: () => time,
  isPlaying: () => playing,
  isScrubbing: () => scrubbing,
  getCues: () => cues,
  getState: () => lastState,
  getActual: () => rig.getActualStates(),
  getEvidence: () => [...evidence.values()],
  seek: (at, autoPlay = false) => seekTo(at, autoPlay),
  play: () => {
    if (time >= duration - 0.03) time = 0;
    playing = true;
  },
  pause: () => {
    playing = false;
  },
  loadScenario: (id, autoPlay = true) => loadScenario(id, autoPlay),
  addCue: cue => {
    cues.push(cue);
    refreshLists();
  },
  formatClock,
};

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (playing && !scrubbing) {
    time += dt;
    if (time >= duration) {
      time = duration;
      playing = false;
    }
  }

  const state = deriveState({ cues, duration, time, scenarioId });
  captureEvidence(lastState, state, playing && !scrubbing);
  rig.sync(state, playing, scrubbing);
  const actual = rig.getActualStates();

  updateHud(refs, state, actual, { selectedSwitchId, evidence, mediaReady, loadError }, playing);

  const selectedEvidence = selectedSwitchId ? evidence.get(selectedSwitchId) : undefined;
  const signature = `${selectedSwitchId}-${state.switches.length}-${selectedEvidence?.settled}-${selectedEvidence?.occurrences}-${Math.round(selectedEvidence?.actualDeltaAfterMs ?? 0)}-${Math.round(selectedEvidence?.actualDeltaBeforeMs ?? 0)}`;
  if (signature !== detailSignature) {
    renderDetail(refs, state, { selectedSwitchId, evidence, mediaReady, loadError }, fullState.switches);
    detailSignature = signature;
  }

  lastState = state;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
