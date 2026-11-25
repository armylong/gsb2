import { buildBoard } from './engine';
import { cloneParked } from './obstacles';
import { SCENARIOS, stationNames } from './scenarios';
import { CANONICAL_MESSAGE, FRAME_LEN } from './symbols';
import type {
  Cue,
  GameState,
  ModalState,
  Policy,
  Pose,
  RunId,
  ScenarioId,
  StationId,
  TabId,
  Toast,
} from './types';

type Listener = () => void;

function forwardManifestFor(id: ScenarioId) {
  if (id !== 'forward') return [];
  return [
    {
      id: 'manifest-east-1',
      msgId: 'frame:tx-origin:0',
      fromStation: 'east' as StationId,
      values: [...CANONICAL_MESSAGE],
      readyStep: 13,
      label: '东崖台转发件',
    },
  ];
}

function initialState(): GameState {
  const def = SCENARIOS.clear;
  return {
    runId: 'clear',
    runName: def.name,
    cues: def.cues,
    cursor: 0,
    playing: false,
    policy: 'lenient',
    editHalf: 0,
    tab: 'script',
    observerFilter: 'all',
    sequences: structuredClone(def.sequences),
    editorStation: 'north',
    previewSymbol: null,
    choices: {},
    manifests: [],
    score: 0,
    signedKeys: [],
    scoreRecords: [],
    attempts: [],
    modal: null,
    toast: null,
    dragTouched: false,
    serial: 1,
  };
}

class Store {
  state: GameState = initialState();
  private listeners = new Set<Listener>();

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  set(patch: Partial<GameState> | ((s: GameState) => Partial<GameState>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.emit();
  }

  notify(text: string, tone: Toast['tone'] = 'ok') {
    const id = this.state.serial;
    this.set((s) => ({
      toast: { id, text, tone },
      serial: s.serial + 1,
    }));
    window.setTimeout(() => {
      if (this.state.toast?.id === id) this.set({ toast: null });
    }, 3200);
  }
}

export const store = new Store();

// 便捷选择器：当前状态下的译码板
export function selectBoard(s: GameState) {
  return buildBoard({
    cues: s.cues,
    cursor: s.cursor,
    policy: s.policy,
    choices: s.choices,
    manifests: s.manifests,
    stationLabels: stationNames,
  });
}

export const actions = {
  setTab(tab: TabId) {
    store.set({ tab });
  },
  setPolicy(policy: Policy) {
    store.set({ policy });
  },
  setHalf(half: 0 | 1) {
    store.set({ editHalf: half });
  },
  setObserverFilter(f: StationId | 'all') {
    store.set({ observerFilter: f });
  },
  setEditorStation(id: StationId) {
    store.set({ editorStation: id });
  },
  setPreviewSymbol(id: string | null) {
    store.set({ previewSymbol: id });
  },

  loadScenario(id: ScenarioId) {
    const def = SCENARIOS[id];
    store.set({
      runId: id,
      runName: def.name,
      cues: structuredClone(def.cues),
      cursor: 0,
      playing: false,
      choices: {},
      manifests: forwardManifestFor(id),
      score: 0,
      signedKeys: [],
      scoreRecords: [],
      attempts: [],
      modal: null,
      sequences: structuredClone(def.sequences),
      toast: null,
      serial: store.state.serial + 1,
    });
  },

  restart() {
    const { runId } = store.state;
    if (runId === 'custom') {
      // 用当前编好的序列重走
      actions.playCustomSequence();
      return;
    }
    actions.loadScenario(runId);
  },

  next() {
    const s = store.state;
    if (s.cursor >= s.cues.length) {
      store.set({ playing: false });
      return;
    }
    store.set({ cursor: s.cursor + 1 });
  },

  prev() {
    const s = store.state;
    if (s.cursor <= 0) return;
    store.set({ cursor: s.cursor - 1, playing: false });
  },

  jumpTo(cursor: number) {
    store.set({
      cursor: Math.max(0, Math.min(cursor, store.state.cues.length)),
      playing: false,
    });
  },

  togglePlay() {
    const s = store.state;
    if (s.cursor >= s.cues.length) {
      store.set({ cursor: 0, playing: true });
    } else {
      store.set({ playing: !s.playing });
    }
  },

  // ---- 序列编辑 ----
  appendSymbol(symbolId: string) {
    const s = store.state;
    const id = s.editorStation;
    const seq = [...s.sequences[id], symbolId];
    store.set({ sequences: { ...s.sequences, [id]: seq } });
  },
  removeChip(index: number) {
    const s = store.state;
    const id = s.editorStation;
    store.set({
      sequences: { ...s.sequences, [id]: s.sequences[id].filter((_, i) => i !== index) },
    });
  },
  clearSequence() {
    const s = store.state;
    const id = s.editorStation;
    store.set({ sequences: { ...s.sequences, [id]: [] } });
  },

  playCustomSequence(station?: StationId) {
    const s = store.state;
    const id = station ?? s.editorStation;
    const seq = s.sequences[id];
    if (seq.length === 0) {
      store.notify('序列是空的，先从符号盘加入几拍', 'warn');
      return;
    }
    const serial = s.serial;
    const cues: Cue[] = seq.map((symbolId, beatIndex) => ({
      id: `custom-${serial}-c${beatIndex}`,
      txId: `tx-custom-${serial}`,
      stepIndex: beatIndex,
      beatIndex,
      sender: id,
      symbolId,
      kind: 'custom',
      layouts: [cloneParked(), cloneParked()],
    }));
    store.set({
      runId: 'custom' as RunId,
      runName: `自编序列 · ${stationNames[id]}`,
      cues,
      cursor: 0,
      playing: true,
      choices: {},
      manifests: [],
      score: 0,
      signedKeys: [],
      scoreRecords: [],
      attempts: [],
      modal: null,
      editorStation: id,
      serial: serial + 1,
    });
  },

  // ---- 拖拽遮挡物，提交到当前 cue 的指定半拍 ----
  commitDrag(cueId: string, half: 0 | 1, obstacleId: string, pose: Pose) {
    const s = store.state;
    const idx = s.cues.findIndex((c) => c.id === cueId);
    if (idx < 0) return;
    const cues = structuredClone(s.cues);
    cues[idx].layouts[half][obstacleId] = pose;
    store.set({ cues, dragTouched: true });
  },

  markDragTouched() {
    if (!store.state.dragTouched) store.set({ dragTouched: true });
  },

  // ---- 模态 / 选择 ----
  openModal(modal: ModalState) {
    store.set({ modal, playing: false });
  },
  closeModal() {
    store.set({ modal: null });
  },

  chooseClaim(msgId: string, slot: number, claimId: string | null) {
    const key = `${msgId}:${slot}`;
    const choices = { ...store.state.choices };
    if (claimId === null) delete choices[key];
    else choices[key] = claimId;
    store.set({ choices });
  },

  // ---- 复核签收 + 计分 ----
  signMessage(msgId: string) {
    const s = store.state;
    const board = selectBoard(s);
    const msg = board.messages.find((m) => m.msgId === msgId);
    const serial = s.serial;
    if (!msg) return;

    const fail = (reason: string, text: string | null) => {
      store.set((st) => ({
        attempts: [
          { serial: st.serial, ok: false, reason, text },
          ...st.attempts,
        ].slice(0, 8),
        serial: st.serial + 1,
      }));
      store.notify(reason, 'bad');
    };

    if (msg.hasUnresolvedConflict) {
      fail('还有来源冲突未人工裁决，不能签收', msg.text);
      return;
    }
    if (!msg.complete) {
      fail(`第 ${msg.missingSlots.map((x) => x + 1).join('、')} 拍仍缺证据，应留待补发`, msg.text);
      return;
    }
    if (!msg.checksumOk) {
      fail('复核规则未通过，消息可能被误读，可重新选择来源或等待补发', msg.text);
      return;
    }

    const values = msg.slots.map((slot) => slot.resolvedValue) as string[];
    const key = values.join('|');
    const duplicate = s.signedKeys.includes(key);
    const record = {
      serial,
      msgKey: key,
      text: msg.text ?? '',
      delta: duplicate ? 0 : 100,
      duplicate,
      sourceLabel: '译码板复核',
    };
    store.set((st) => ({
      score: st.score + record.delta,
      signedKeys: duplicate ? st.signedKeys : [...st.signedKeys, key],
      scoreRecords: [record, ...st.scoreRecords].slice(0, 20),
      attempts: [
        {
          serial: st.serial,
          ok: true,
          reason: duplicate ? '同一消息重复收到，不重复得分' : '开头 / 结尾 / 复核全部通过',
          text: msg.text,
        },
        ...st.attempts,
      ].slice(0, 8),
      serial: st.serial + 1,
    }));
    store.notify(
      duplicate ? '重复消息：不再得分' : '复核通过，签收 +100',
      duplicate ? 'warn' : 'ok',
    );
  },

  // ---- 请求原发台补发某个缺槽 ----
  resendSlot(msgId: string, slot: number) {
    const s = store.state;
    const board = selectBoard(s);
    const msg = board.messages.find((m) => m.msgId === msgId);
    if (!msg || !msg.sender || msg.startBeat === null || !msg.txId) {
      store.notify('找不到这条消息的原发序列', 'bad');
      return;
    }
    const originCue = s.cues.find(
      (c) => c.txId === msg.txId && c.beatIndex === (msg.startBeat as number) + slot,
    );
    if (!originCue) {
      store.notify('原拍已不存在，无法补发', 'bad');
      return;
    }
    const stepIndex = s.cues.length;
    const cue: Cue = {
      id: `resend-${s.serial}`,
      txId: `tx-resend-${msgId}-${slot}-${s.serial}`,
      stepIndex,
      beatIndex: 0,
      sender: msg.sender,
      symbolId: originCue.symbolId,
      kind: 'resend',
      assign: { msgId, slot },
      layouts: [cloneParked(), cloneParked()],
      note: `申报为原消息第 ${slot + 1} 拍补发`,
    };
    store.set((st) => ({
      cues: [...st.cues, cue],
      cursor: stepIndex + 1,
      serial: st.serial + 1,
    }));
    store.notify(`第 ${slot + 1} 拍补发已到达收条`, 'ok');
  },

  // ---- 从另一台转发整条消息 ----
  forwardMessage(msgId: string, fromStation: StationId) {
    const s = store.state;
    const board = selectBoard(s);
    const msg = board.messages.find((m) => m.msgId === msgId);
    if (!msg) return;
    if (!msg.complete || !msg.checksumOk) {
      store.notify('只能转发已通过复核的完整消息', 'warn');
      return;
    }
    if (msg.sender === fromStation) {
      store.notify('转发要从另外一处的台发出，请选别的台', 'warn');
      return;
    }
    const values = msg.slots.map((slot) => slot.resolvedValue) as string[];
    const startStep = s.cues.length;
    const txId = `tx-fwd-manual-${s.serial}`;
    const newCues: Cue[] = values.map((symbolId, slot) => ({
      id: `fwd-manual-${s.serial}-${slot}`,
      txId,
      stepIndex: startStep + slot,
      beatIndex: slot,
      sender: fromStation,
      symbolId,
      kind: 'forward',
      assign: { msgId, slot },
      layouts: [cloneParked(), cloneParked()],
      note: `${stationNames[fromStation]}转发第 ${slot + 1} 拍`,
    }));
    const manifest = {
      id: `manifest-manual-${s.serial}`,
      msgId,
      fromStation,
      values,
      readyStep: startStep + FRAME_LEN - 1,
      label: `${stationNames[fromStation]}转发件`,
    };
    store.set((st) => ({
      cues: [...st.cues, ...newCues],
      manifests: [...st.manifests, manifest],
      serial: st.serial + 1,
    }));
    store.notify('转发序列已排到队尾，逐拍推进接收', 'ok');
  },
};
