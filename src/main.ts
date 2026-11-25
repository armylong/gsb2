import './styles.css';
import { audio } from './audio/engine';
import {
  adviseConditions,
  buildEvidence,
  compatibleComboIds,
  evidenceStatus,
} from './game/evidence';
import { PUZZLES } from './game/plates';
import { store } from './state/store';
import { h, mount } from './ui/dom';
import { renderRack } from './ui/rack';
import { renderHistory, renderStage } from './ui/stage';
import { renderCandidates, renderEvidencePanel } from './ui/deduction';
import { renderReveal } from './ui/reveal';

const app = document.getElementById('app')!;

function puzzleBadge(puzzleId: string): HTMLElement | null {
  const state = store.getState();
  const progress = state.puzzles[puzzleId];
  const puzzle = PUZZLES.find((p) => p.id === puzzleId)!;

  if (progress.phase === 'submitted' && progress.result) {
    if (progress.result.gaveUp) {
      return h('span.pt-badge.done-bad', { text: '已核对' });
    }
    return progress.result.correct
      ? h('span.pt-badge.done-ok', { text: '✓ 推理正确' })
      : h('span.pt-badge.done-bad', { text: '✗ 再挑战' });
  }
  if (progress.records.length > 0) {
    return h('span.pt-badge', {
      style: 'background:var(--teal);color:#eafaf6;border-color:var(--teal-dark);',
      text: `取证 ${progress.records.length}`,
    });
  }
  return h(
    `span.pt-badge.${puzzle.difficulty}`,
    { text: puzzle.difficulty === 'easy' ? '易辨认' : '有歧义' },
  );
}

function renderTop(): HTMLElement {
  const state = store.getState();
  const tabs = PUZZLES.map((puzzle) =>
    h(
      `button.puzzle-tab${state.currentPuzzleId === puzzle.id ? '.active' : ''}`,
      {
        type: 'button',
        onClick: () => {
          audio.stopAll();
          store.switchPuzzle(puzzle.id);
        },
      },
      h(
        'span',
        null,
        h('div.pt-name', { text: `${puzzle.groupName} · ${puzzle.title}` }),
        h('div.pt-tag', { text: puzzle.tagline }),
      ),
      puzzleBadge(puzzle.id),
    ),
  );

  return h(
    'header',
    null,
    h(
      'div.topbar',
      null,
      h(
        'div.brand',
        null,
        h(
          'span.brand-mark',
          { 'aria-hidden': 'true' },
          // 风铃 SVG
          (() => {
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('width', '28');
            svg.setAttribute('height', '28');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.7');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.innerHTML =
              '<path d="M12 3v2"/><path d="M5 21h14"/><path d="M6 21c0-6 2.7-10 6-10s6 4 6 10"/><path d="M9 11V8.5a3 3 0 0 1 6 0V11"/><circle cx="12" cy="16" r="1.4"/><path d="M12 17.4V21"/>';
            return svg;
          })(),
        ),
        h(
          'div',
          null,
          h('h1', { text: '风铃辨片 · 木盒探案' }),
          h('div.sub', { text: '程序合成声音 · 从听过的组合中推出不透明盒里的铃片' }),
        ),
      ),
      h(
        'div.top-meta',
        null,
        h('span.save-hint', { text: '💾 两组固定题 · 进度自动保存在本浏览器，重开回到同组' }),
      ),
    ),
    h('nav.puzzle-tabs', { 'aria-label': '固定题组' }, tabs),
  );
}

function render(): void {
  const puzzle = store.currentPuzzle;
  const progress = store.progress;
  const ev = buildEvidence(progress);
  const compatible = compatibleComboIds(ev);
  const status = evidenceStatus(ev);
  const advice = adviseConditions(ev, [...puzzle.truth]);

  const reveal = renderReveal();

  const root = h(
    'div',
    null,
    renderTop(),
    h('div.briefing', null, h('b', { text: '案情简报：' }), puzzle.briefing),
    reveal,
    h(
      'main.layout',
      null,
      h(
        'div.col-main',
        null,
        renderStage(advice),
        renderRack(),
        renderHistory(),
      ),
      h(
        'div.col-side',
        null,
        renderEvidencePanel(ev, status, compatible, advice),
        renderCandidates(compatible),
      ),
    ),
    h(
      'footer.footer-note',
      null,
      '所有铃声均由 Web Audio 振荡器与噪声实时合成，无音频文件、无随机题面。',
      h('br'),
      '推理模型：粗音高带声纹 + 全响/压制 A-B 细指纹；候选组合与证据等价关系由 TypeScript 枚举计算。',
    ),
  );

  mount(app, root);
}

store.subscribe(render);
window.addEventListener('ui:toggle-hide-excluded', render);

// 首次任意点击 / 按键时解锁 AudioContext（浏览器自动播放策略）
const unlock = () => {
  try {
    audio.ensure();
  } catch {
    /* ignore */
  }
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

render();

// 调试 / 自动化自检钩子
declare global {
  interface Window {
    __wc?: { store: typeof store; audio: typeof audio };
  }
}
window.__wc = { store, audio };
