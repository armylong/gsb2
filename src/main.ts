import './styles.css';
import { actions, store } from './game/store';
import type { ScenarioId, TabId } from './game/types';
import { stationNames } from './game/scenarios';
import { SYMBOL_MAP } from './game/symbols';
import { mountScene, sceneApi } from './ui/scene-canvas';
import {
  renderModal,
  renderPanel,
  renderToast,
  renderTransport,
  rulesPageHtml,
} from './ui/panels';

const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
if (!canvas) throw new Error('#scene canvas missing');
mountScene(canvas);

const transportEl = document.getElementById('transport') as HTMLElement;
const panelEl = document.getElementById('panel') as HTMLElement;
const modalRoot = document.getElementById('modal-root') as HTMLElement;
const toastRoot = document.getElementById('toast-root') as HTMLElement;
const scorePill = document.getElementById('score-pill') as HTMLElement;
const cueTitle = document.getElementById('cue-title') as HTMLElement;
const cueNote = document.getElementById('cue-note') as HTMLElement;
const rulesBottom = document.getElementById('rules-bottom') as HTMLElement;

rulesBottom.innerHTML = rulesPageHtml();

function renderAll() {
  const s = store.state;
  transportEl.innerHTML = renderTransport(s);
  panelEl.innerHTML = renderPanel(s);
  modalRoot.innerHTML = renderModal(s);
  toastRoot.innerHTML = renderToast(s);
  scorePill.textContent = `得分 ${s.score}`;

  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === s.tab);
  });
  document.querySelectorAll<HTMLElement>('.half-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.half === String(s.editHalf));
  });

  const cue = s.cursor > 0 ? s.cues[s.cursor - 1] : null;
  if (cue) {
    cueTitle.textContent = `第 ${cue.stepIndex + 1} 拍 · ${stationNames[cue.sender]} · 举「${SYMBOL_MAP[cue.symbolId]?.label ?? '？'}」`;
    cueNote.textContent = [cue.tag ? `【${cue.tag}】` : '', cue.note ?? ''].filter(Boolean).join(' ');
  } else {
    cueTitle.textContent = '尚未开演';
    cueNote.textContent = '选择剧本或自编序列，逐拍推进';
  }
}

store.subscribe(renderAll);
renderAll();

// 调试 / 自动化句柄
(window as unknown as { __flag: unknown }).__flag = { store, actions };

// 自动逐拍节拍器
window.setInterval(() => {
  const s = store.state;
  if (!s.playing) return;
  if (s.cursor >= s.cues.length) store.set({ playing: false });
  else actions.next();
}, 900);

// 统一点击事件委托
document.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const el = target.closest<HTMLElement>('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const s = store.state;

  switch (action) {
    case 'tab':
      actions.setTab(el.dataset.tab as TabId);
      break;
    case 'load-scenario':
      actions.loadScenario(el.dataset.id as ScenarioId);
      break;
    case 'restart':
      actions.restart();
      break;
    case 'prev':
      actions.prev();
      break;
    case 'next':
      actions.next();
      break;
    case 'toggle-play':
      actions.togglePlay();
      break;
    case 'set-policy':
      actions.setPolicy((el.dataset.policy as 'lenient' | 'strict') ?? 'lenient');
      break;
    case 'set-half':
      actions.setHalf(Number(el.dataset.half) === 1 ? 1 : 0);
      break;
    case 'sweep':
      sceneApi.sweep();
      break;
    case 'set-filter':
      actions.setObserverFilter((el.dataset.id as 'all' | 'north' | 'west' | 'east') ?? 'all');
      break;
    case 'set-editor-station':
      actions.setEditorStation(el.dataset.id as never);
      break;
    case 'append-symbol':
      if (el.dataset.symbol) actions.appendSymbol(el.dataset.symbol);
      break;
    case 'remove-chip':
      actions.removeChip(Number(el.dataset.index));
      break;
    case 'clear-seq':
      actions.clearSequence();
      break;
    case 'play-custom':
      actions.playCustomSequence();
      break;
    case 'open-conflict':
      actions.openModal({
        type: 'conflict',
        msgId: el.dataset.msg!,
        slot: Number(el.dataset.slot),
      });
      break;
    case 'open-obs':
      actions.openModal({
        type: 'observation',
        cueId: el.dataset.cue!,
        observer: el.dataset.observer as never,
      });
      break;
    case 'close-modal':
      actions.closeModal();
      break;
    case 'backdrop-close':
      // 只有直接点在遮罩本身（带 data-backdrop）上才关闭
      if ((ev.target as HTMLElement).dataset.backdrop !== undefined) actions.closeModal();
      break;
    case 'choose-claim':
      actions.chooseClaim(el.dataset.msg!, Number(el.dataset.slot), el.dataset.claim!);
      break;
    case 'choose-auto':
      actions.chooseClaim(el.dataset.msg!, Number(el.dataset.slot), null);
      break;
    case 'inspect-claim': {
      const cue = s.cues.find((c) => c.id === el.dataset.cue);
      if (cue) actions.jumpTo(cue.stepIndex + 1);
      actions.openModal({
        type: 'observation',
        cueId: el.dataset.cue!,
        observer: el.dataset.observer as never,
      });
      break;
    }
    case 'sign':
      actions.signMessage(el.dataset.msg!);
      break;
    case 'resend':
      actions.resendSlot(el.dataset.msg!, Number(el.dataset.slot));
      break;
    case 'forward':
      actions.forwardMessage(el.dataset.msg!, el.dataset.station as never);
      break;
    default:
      break;
  }
});

// 走拍滑杆在 change（松手 / 键盘提交）时跳转，避免拖动中重建 DOM
document.addEventListener('change', (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.dataset.action === 'scrub') {
    actions.jumpTo(Number(input.value));
  }
});

// 键盘左右方向键走拍（输入控件聚焦时不抢）
document.addEventListener('keydown', (ev) => {
  const tag = (ev.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (store.state.modal) {
    if (ev.key === 'Escape') actions.closeModal();
    return;
  }
  if (ev.key === 'ArrowRight') actions.next();
  if (ev.key === 'ArrowLeft') actions.prev();
});
