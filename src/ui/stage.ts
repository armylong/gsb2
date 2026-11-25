import { audio } from '../audio/engine';
import {
  CONDITION_KEYS,
  conditionLabel,
  type ConditionAdvice,
} from '../game/evidence';
import { POSITION_LABELS, PLATE_MAP } from '../game/plates';
import { store } from '../state/store';
import type { ConditionKey } from '../game/types';
import { h } from './dom';
import { playSolo, replayCondition, strikeOrReplay } from './actions';
import { bandChip, fineReadout } from './bits';

const STRIKE_SUB: Record<ConditionKey, string> = {
  all: '三片同时自由鸣响',
  m0: '左格铃片被压住制音',
  m1: '中格铃片被压住制音',
  m2: '右格铃片被压住制音',
};

export function renderStage(advice: ConditionAdvice[]): HTMLElement {
  const puzzle = store.currentPuzzle;
  const p = store.progress;
  const ended = p.phase === 'submitted';
  const used = p.records.length;
  const budgetLeft = puzzle.budget - used;

  // —— 木盒三格：结束前是不透明盖面，结束后公开真实铃片并可点奏 ——
  const slots = puzzle.truth.map((id, pos) => {
    const plate = PLATE_MAP[id];
    const inner = ended
      ? h(
          'button.truth-disc',
          {
            type: 'button',
            style: `background: radial-gradient(circle at 34% 28%, ${plate.color}ee, ${plate.color} 58%, #00000066);`,
            title: `单击试听 ${plate.name}`,
            'aria-label': `试听${plate.name}`,
            onClick: (e: MouseEvent) =>
              playSolo(id, false, e.currentTarget as HTMLElement),
          },
          plate.name[0],
        )
      : h('span.lid-mark', { 'aria-hidden': 'true' }, '?');

    return h(
      'div.pos-slot',
      null,
      h('div.slot-window', null, inner),
      h('span.pos-label', { text: POSITION_LABELS[pos] }),
      h('span.pos-pan', { text: ['声像 · 左', '声像 · 中', '声像 · 右'][pos] }),
    );
  });

  // —— 四个敲击条件按钮 ——
  const adviceMap = new Map(advice.map((a) => [a.key, a]));
  const strikeButtons = CONDITION_KEYS.map((key) => {
    const rec = p.records.find((r) => r.key === key);
    const tested = !!rec;
    const noBudget = !tested && budgetLeft <= 0;
    const adv = adviceMap.get(key);

    const classes = [
      'strike-btn',
      key === 'all' ? 'all' : '',
      tested ? 'is-tested' : '',
      noBudget ? 'is-locked-no-budget' : '',
    ].filter(Boolean);

    const statusLine = tested
      ? '↻ 回放此条件'
      : noBudget
        ? '次数已尽'
        : ended
          ? '已结束'
          : adv?.decisive
            ? '★ 可唯一锁定'
            : adv && adv.branching > 1
              ? `可区分 · ${adv.branching} 种走向`
              : STRIKE_SUB[key];

    return h(
      `button.${classes.join('.')}`,
      {
        type: 'button',
        dataset: { strike: key },
        disabled: ended && !tested ? true : noBudget && !tested ? true : false,
        'aria-label': conditionLabel(key),
        onClick: (e: MouseEvent) =>
          strikeOrReplay(key, e.currentTarget as HTMLElement),
      },
      tested ? h('span.tested-tick', { text: '✓ 已取证' }) : null,
      h(
        'span',
        {
          style: key === 'all' ? 'font-size:15.5px;letter-spacing:2px;' : undefined,
          text: key === 'all' ? '🔨 全响' : `🤚 压${POSITION_LABELS[Number(key[1]) as 0 | 1 | 2].replace('格', '')}格`,
        },
      ),
      h('span.sb-sub', { text: statusLine }),
    );
  });

  // —— 次数圆点 ——
  const pips = [];
  for (let i = 0; i < puzzle.budget; i++) {
    pips.push(h(`span.pip${i < used ? '.used' : ''}`));
  }

  return h(
    'section.panel.strike-panel',
    null,
    h(
      'div.panel-head',
      null,
      h('h2', null, h('span.idx', { text: '贰' }), '不透明木盒 · 敲击台'),
      h(
        'span.pips',
        null,
        h('span', { text: '可用敲击' }),
        pips,
        h('span.pip-left-num', { text: String(Math.max(0, budgetLeft)) }),
        h('span', { text: `/ ${puzzle.budget} 次` }),
      ),
    ),
    h('div.box-stage', null, h('div.box-inner', null, h('div.pos-slots', null, slots))),
    h('div.strike-grid', null, strikeButtons),
    h(
      'p.hint-line',
      null,
      '💡 ',
      ended
        ? '本题已结束，所有已保留条件与真实铃片都可以继续点击核对。'
        : '每个条件只需敲响一次即永久保留；之后点按钮或记录里的「回放」免费重听，不消耗次数。建议戴耳机或用左右声道分明的设备。',
    ),
    h(
      'div',
      { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;' },
      h(
        'button.btn.btn-ghost',
        { type: 'button', onClick: () => audio.stopAll() },
        '⏹ 停止所有声音',
      ),
    ),
  );
}

export function renderHistory(): HTMLElement {
  const p = store.progress;

  let body: HTMLElement;
  if (p.records.length === 0) {
    body = h(
      'div.history-empty',
      null,
      '还没有试听记录。先在上方敲响「全响」或「压住某格」——每一种试听条件都会保留在这里，供之后免费回放对比。',
    );
  } else {
    const items = p.records.map((rec, idx) => {
      const finePos =
        rec.key === 'all'
          ? // 全响记录：列出所有因它而完成的 A/B 位置
            (Object.keys(p.fineCodes) as string[]).map(Number)
          : p.fineCodes[Number(rec.key[1]) as 0 | 1 | 2]
            ? [Number(rec.key[1])]
            : [];

      return h(
        'div.history-item',
        null,
        h('span.hist-index', { text: String(idx + 1).padStart(2, '0') }),
        h(
          'div.hist-body',
          null,
          h(
            'div.hist-title',
            null,
            conditionLabel(rec.key),
            h(
              'span.hist-time',
              { text: new Date(rec.at).toLocaleTimeString('zh-CN', { hour12: false }) },
            ),
          ),
          h(
            'div.hist-chips',
            null,
            rec.analysis.bandsByPos.map((b) => bandChip(b)),
            finePos.map((pos) =>
              h(
                'span.chip.fine',
                { title: fineReadout(p.fineCodes[pos as 0 | 1 | 2]!) },
                `🔬 ${POSITION_LABELS[pos]}差分指纹`,
              ),
            ),
          ),
        ),
        h(
          'button.btn.btn-ghost.hist-replay',
          {
            type: 'button',
            onClick: (e: MouseEvent) =>
              replayCondition(rec.key, e.currentTarget as HTMLElement),
          },
          '↻ 回放',
        ),
      );
    });
    body = h('div.history-list', null, items);
  }

  return h(
    'section.panel.history-panel',
    null,
    h(
      'div.panel-head',
      null,
      h('h2', null, h('span.idx', { text: '叁' }), '试听条件记录'),
      h('span.desc', { text: `${p.records.length} 条 · 点击回放不消耗次数` }),
    ),
    body,
  );
}
