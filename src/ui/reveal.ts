import { audio } from '../audio/engine';
import { PLATE_MAP, PUZZLES } from '../game/plates';
import { store } from '../state/store';
import { h } from './dom';
import { answerPill } from './bits';
import { playSolo, replayCondition } from './actions';
import { confirmModal } from './feedback';
import type { PlateId } from '../game/types';

export function renderReveal(): HTMLElement | null {
  const puzzle = store.currentPuzzle;
  const p = store.progress;
  if (p.phase !== 'submitted' || !p.result) return null;

  const result = p.result;
  const selectedCombo = p.selected;
  const win = !result.gaveUp && result.correct;

  let stamp: string;
  let title: string;
  let sub: string;
  if (result.gaveUp) {
    stamp = '核对';
    title = '真相已公开';
    sub = '先听听六片铃片的公开声音，再对照真实摆放与鉴别讲解，然后可以重玩本组。';
  } else if (win && result.evidenceUnique) {
    stamp = '实证';
    title = '判断正确，而且证据链唯一';
    sub = '你在提交前已通过声纹证据把组合唯一锁定——这是最扎实的胜利。';
  } else if (win) {
    stamp = '耳辨';
    title = '判断正确！当时严格证据并不唯一';
    sub = `提交瞬间仍有 ${result.evidenceCompatibleCount} 种声纹等价组合；你凭借音高 / 余音的听觉依据手动排除了其余可能，不是随机运气。`;
  } else {
    stamp = '有误';
    title = '这次选错了，来核对声音与摆放';
    sub = `提交瞬间有 ${result.evidenceCompatibleCount} 种组合证据相同。看看下面的确定性鉴别依据，重玩同一固定题组再战。`;
  }

  // —— 你的答案 vs 真实组合 ——
  const yourAnswer = selectedCombo
    ? (selectedCombo.split('+') as PlateId[]).map((id) => answerPill(id))
    : h('span.answer-empty', { text: '未提交选择（直接核对）' });

  const truthAnswer = puzzle.truth.map((id) => answerPill(id));

  // —— 真实三格摆放，每片可单独敲响 / 闷住 ——
  const revealSlots = puzzle.truth.map((id, pos) => {
    const plate = PLATE_MAP[id];
    return h(
      'div.reveal-slot',
      null,
      h(
        'button.truth-disc',
        {
          type: 'button',
          style: `background: radial-gradient(circle at 34% 28%, ${plate.color}ee, ${plate.color} 58%, #00000066);`,
          title: `试听 ${plate.name}`,
          onClick: (e: MouseEvent) =>
            playSolo(id, false, e.currentTarget as HTMLElement),
        },
        plate.name[0],
      ),
      h('span.rs-name', { text: `${['左格', '中格', '右格'][pos]} · ${plate.name}` }),
      h('span.rs-spec', null, plate.pitchLabel, h('br'), `余音 ${plate.decay.toFixed(2)}s（${plate.decayWord}）`),
      h(
        'div.rs-actions',
        null,
        h(
          'button.btn.btn-ghost',
          { type: 'button', onClick: () => playSolo(id, false) },
          '🔔 敲响',
        ),
        h(
          'button.btn.btn-ghost',
          { type: 'button', onClick: () => playSolo(id, true) },
          '🤚 闷住',
        ),
      ),
    );
  });

  // —— 鉴别演示按钮 ——
  const demos: HTMLElement[] = [];
  if (puzzle.debrief.closePair) {
    demos.push(
      h(
        'div.demo-row',
        null,
        h(
          'button.btn.btn-teal',
          {
            type: 'button',
            onClick: (e: MouseEvent) => {
              // 悠商长余音 -> 浮烟短余音，连续对比
              audio.playSequence([
                { plate: 'shang', hold: 1.7 },
                { plate: 'fu', hold: 1 },
              ]);
              const btn = e.currentTarget as HTMLElement;
              btn.textContent = '▶ 先悠商(长) 后浮烟(短)';
            },
          },
          '🎧 对比近音高 pair：悠商 → 浮烟',
        ),
        h(
          'button.btn.btn-ghost',
          {
            type: 'button',
            onClick: () => {
              audio.playPlate(PLATE_MAP.shang);
            },
          },
          '只听悠商长尾',
        ),
        h(
          'button.btn.btn-ghost',
          { type: 'button', onClick: () => audio.playPlate(PLATE_MAP.fu) },
          '只听浮烟短尾',
        ),
      ),
    );
  }
  if (puzzle.debrief.overlap) {
    const quanPos = puzzle.truth.indexOf('quan');
    const suiPos = puzzle.truth.indexOf('sui');
    demos.push(
      h(
        'div.demo-row',
        null,
        h(
          'button.btn.btn-teal',
          {
            type: 'button',
            onClick: () => {
              audio.playPlate(PLATE_MAP.quan, { pan: -0.25 });
              audio.playPlate(PLATE_MAP.sui, { pan: 0.3 });
            },
          },
          '🎧 重叠 pair：鸣泉 + 碎星同响',
        ),
        quanPos >= 0
          ? h(
              'button.btn.btn-ghost',
              { type: 'button', onClick: () => replayCondition(`m${quanPos}` as `m0`) },
              `压${['左', '中', '右'][quanPos]}格(鸣泉)再听`,
            )
          : null,
        suiPos >= 0
          ? h(
              'button.btn.btn-ghost',
              { type: 'button', onClick: () => replayCondition(`m${suiPos}` as `m0`) },
              `压${['左', '中', '右'][suiPos]}格(碎星)再听`,
            )
          : null,
      ),
    );
  }

  const other = PUZZLES.find((q) => q.id !== puzzle.id)!;

  return h(
    `section.reveal-panel.${win ? 'win' : 'lose'}`,
    { id: 'reveal' },
    h(
      'div.reveal-head',
      null,
      h('span.reveal-stamp', { text: stamp }),
      h(
        'div',
        null,
        h('div.reveal-title', { text: title }),
        h('div.reveal-sub', { text: sub }),
      ),
    ),
    h(
      'div.reveal-answers',
      null,
      h('div.answer-box', null, h('h3', { text: '你的组合' }), h('div.answer-combo', null, yourAnswer)),
      h('div.answer-box', null, h('h3', { text: '真实组合' }), h('div.answer-combo', null, truthAnswer)),
    ),
    h(
      'div.reveal-arrangement',
      null,
      h('h3', { text: '真实摆放（三格声像位置，铃片为公开声音，可逐片核对）' }),
      h('div.reveal-slots', null, revealSlots),
    ),
    h(
      'div.debrief',
      null,
      puzzle.debrief.closePair
        ? h('div.debrief-item', null, h('b', { text: '近音高两片：' }), puzzle.debrief.closePair, demos[0])
        : null,
      puzzle.debrief.overlap
        ? h(
            'div.debrief-item.overlap',
            null,
            h('b', { text: '响声重叠组：' }),
            puzzle.debrief.overlap,
            demos[puzzle.debrief.closePair ? 1 : 0],
          )
        : null,
      h('div.debrief-item.decisive', null, h('b', { text: '确定性依据：' }), puzzle.debrief.decisive),
    ),
    h(
      'div.reveal-actions',
      null,
      h(
        'button.btn.btn-primary',
        {
          type: 'button',
          style: 'width:auto;',
          onClick: async () => {
            const ok = await confirmModal({
              title: '重玩本组固定题？',
              body: '敲击记录、排除与选择都会清空，但题组与真实摆放不变。',
              confirmText: '重玩本组',
              cancelText: '取消',
              tone: 'teal',
            });
            if (ok) {
              store.resetCurrentPuzzle();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          },
        },
        '🔄 重玩本组（同题）',
      ),
      h(
        'button.btn.btn-teal',
        {
          type: 'button',
          onClick: () => {
            store.switchPuzzle(other.id);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          },
        },
        `切换到${other.groupName} · ${other.title}`,
      ),
      h(
        'button.btn.btn-ghost',
        { type: 'button', onClick: () => replayCondition('all') },
        '↻ 回放真实摆放的全响',
      ),
    ),
  );
}
