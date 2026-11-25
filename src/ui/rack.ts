import { PLATES } from '../game/plates';
import { store } from '../state/store';
import { h } from './dom';
import { playSolo } from './actions';

export function renderRack(): HTMLElement {
  const puzzle = store.currentPuzzle;
  const ended = store.progress.phase === 'submitted';
  const truthSet = new Set(puzzle.truth);

  const cards = PLATES.map((plate) => {
    const widthPct = Math.min(100, (plate.decay / 4) * 100);
    const isTruth = ended && truthSet.has(plate.id);

    const card = h(
      `div.plate-card${isTruth ? '.truth' : ''}`,
      null,
      isTruth ? h('span.truth-ribbon', { text: '真实盒中片' }) : null,
      h(
        'div.plate-top',
        null,
        h(
          'div.plate-disc',
          {
            style: `background: radial-gradient(circle at 34% 28%, ${plate.color}dd, ${plate.color} 55%, #00000055);`,
            title: plate.name,
          },
          plate.name[0],
        ),
        h(
          'div',
          null,
          h('div.plate-name', { text: plate.name }),
          h('div.plate-sub', { text: plate.subtitle }),
        ),
      ),
      h(
        'div.plate-pitch',
        null,
        h('span', { text: plate.pitchLabel.split(' · ')[0] }),
        h('span.freq', { text: plate.pitchLabel.split(' · ')[1] }),
      ),
      h(
        'div.decay-row',
        null,
        h('span', { text: '余音' }),
        h(
          'div.decay-meter',
          { 'aria-hidden': 'true' },
          h('div.decay-fill', {
            style: `width:${widthPct}%;background:linear-gradient(90deg, ${plate.color}99, ${plate.color});`,
          }),
        ),
        h('span.decay-val', { text: `${plate.decay.toFixed(2)}s · ${plate.decayWord}` }),
      ),
      h('p.plate-learn', { text: plate.learn }),
      h(
        'div.plate-actions',
        null,
        h(
          'button.btn.btn-teal',
          {
            type: 'button',
            onClick: (e: MouseEvent) =>
              playSolo(plate.id, false, e.currentTarget as HTMLElement),
          },
          '🔔 敲响',
        ),
        h(
          'button.btn.btn-ghost',
          {
            type: 'button',
            title: '听一听这片被压住时的闷短声响',
            onClick: (e: MouseEvent) =>
              playSolo(plate.id, true, e.currentTarget as HTMLElement),
          },
          '🤚 闷住',
        ),
      ),
    );
    return card;
  });

  return h(
    'section.panel.rack-panel',
    null,
    h(
      'div.panel-head',
      null,
      h('h2', null, h('span.idx', { text: '壹' }), '公开试听栏'),
      h('span.desc', { text: '六片铃片可无限次单独敲响，记住音高与余音' }),
    ),
    h('div.rack-grid', null, cards),
  );
}
