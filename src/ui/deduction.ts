import { COMBOS, comboIdOf } from '../game/combos';
import type { ConditionAdvice, Evidence, EvidenceStatus } from '../game/evidence';
import { conditionLabel } from '../game/evidence';
import { POSITION_LABELS, PLATE_MAP } from '../game/plates';
import { store } from '../state/store';
import { h } from './dom';
import { bandChip, fineReadout } from './bits';
import { strikeOrReplay } from './actions';
import { handleGiveUp, handleSubmit } from './submit-flow';

let hideExcluded = false;

function renderBanner(status: EvidenceStatus, excluded: string[]): HTMLElement {
  if (status.kind === 'empty') {
    return h(
      'div.evi-banner.empty',
      null,
      h('div.evi-title', null, '🧭 尚未取得声纹证据'),
      h('div', { text: '20 种三铃片组合都还可能。先敲响木盒，或直接点选一个候选后提交（会提示盲猜）。' }),
    );
  }
  if (status.kind === 'unique') {
    const combo = COMBOS.find((c) => c.id === status.comboId)!;
    return h(
      'div.evi-banner.unique',
      null,
      h('div.evi-title', null, '✅ 证据已唯一锁定'),
      h(
        'div',
        null,
        '所有已测试敲法的声纹都只对应：',
        h('b', {
          style: 'font-size:15px;letter-spacing:1px;',
          text: ` ${combo.plates.map((p) => PLATE_MAP[p].name).join(' · ')}`,
        }),
        '。可直接选定并提交。',
      ),
    );
  }

  const unexcluded = status.comboIds.filter((id) => !excluded.includes(id));
  return h(
    'div.evi-banner.ambiguous',
    null,
    h(
      'div.evi-title',
      null,
      `⚠️ 信息不足：${status.comboIds.length} 种组合与证据完全相同`,
    ),
    h(
      'div',
      null,
      '下列组合在你已测试的敲法下会产生相同的粗声纹 / 差分指纹，无法仅凭现有证据区分：',
    ),
    h(
      'ul.evi-combo-list',
      null,
      status.comboIds.map((id) => {
        const combo = COMBOS.find((c) => c.id === id)!;
        const isEx = excluded.includes(id);
        return h(
          'li',
          { style: isEx ? 'opacity:.55;text-decoration:line-through;' : undefined },
          combo.plates.map((p) => PLATE_MAP[p].name).join(' · '),
          isEx ? h('span.equiv-note', { text: '（你已排除）' }) : null,
        );
      }),
    ),
    h(
      'div',
      { style: 'margin-top:7px;font-weight:700;' },
      unexcluded.length > 1
        ? `仍有 ${unexcluded.length} 种未排除——提交前请确认这是有依据的判断，而不是猜。`
        : unexcluded.length === 1
          ? '你已手动排除到只剩 1 种：若依据是余音 / 音高的听觉对比，可以提交。'
          : '等价组合都已被你排除（注意：这与声纹证据冲突，请谨慎）。',
    ),
  );
}

function renderFacts(ev: Evidence): HTMLElement {
  const rows = [0, 1, 2].map((pos) => {
    const band = ev.bandsByPos[pos];
    const fine = ev.fineByPos[pos];
    return h(
      'div.fact-row',
      null,
      h('span.fact-pos', { text: POSITION_LABELS[pos] }),
      h(
        'div.fact-bands',
        null,
        band ? bandChip(band) : h('span.fact-empty', { text: '尚无该位置声纹' }),
        fine
          ? h(
              'span.chip.fine',
              { title: fine, style: 'cursor:help;' },
              '🔬 ',
              h('span', { text: fineReadout(fine) }),
            )
          : null,
      ),
    );
  });
  return h('div.evi-facts', null, rows);
}

function renderAdvice(advice: ConditionAdvice[], budgetLeft: number, ended: boolean): HTMLElement {
  const chips = advice.map((a) => {
    const icon = a.tested ? '✓' : a.decisive ? '★' : a.branching > 1 ? '❓' : '·';
    const title = a.tested
      ? `${conditionLabel(a.key)} 已取证，点击回放`
      : a.decisive
        ? `测试「${conditionLabel(a.key)}」后实际会只剩 ${a.actualComboCount} 种组合`
        : `该条件会产生 ${a.branching} 种可能的证据走向`;
    return h(
      `button.advice-chip${a.decisive && !a.tested ? '.decisive' : ''}${a.tested ? '.tested' : ''}`,
      {
        type: 'button',
        title,
        disabled: ended ? !a.tested : !a.tested && budgetLeft <= 0 ? true : false,
        onClick: (e: MouseEvent) =>
          strikeOrReplay(a.key, e.currentTarget as HTMLElement),
      },
      `${icon} ${a.label}`,
      a.tested ? '' : a.decisive ? '· 可唯一锁定' : a.branching > 1 ? `· 分${a.branching}支` : '',
    );
  });

  return h(
    'div.advice-block',
    null,
    h('div.advice-title', { text: '下一步取证建议（点击直接敲响）' }),
    h('div.advice-list', null, chips),
  );
}

export function renderEvidencePanel(
  ev: Evidence,
  status: EvidenceStatus,
  compatible: string[],
  advice: ConditionAdvice[],
): HTMLElement {
  const p = store.progress;
  const puzzle = store.currentPuzzle;
  const budgetLeft = puzzle.budget - p.records.length;

  return h(
    'section.panel.evidence-panel',
    null,
    h(
      'div.panel-head',
      null,
      h('h2', null, h('span.idx', { text: '证' }), '当前证据'),
      h('span.desc', {
        text: `已试 ${p.records.length}/${puzzle.budget} · 一致组合 ${compatible.length}/20`,
      }),
    ),
    renderBanner(status, p.excluded),
    renderFacts(ev),
    renderAdvice(advice, budgetLeft, p.phase === 'submitted'),
  );
}

export function renderCandidates(compatible: string[]): HTMLElement {
  const p = store.progress;
  const ended = p.phase === 'submitted';
  const compatibleSet = new Set(compatible);
  const excludedSet = new Set(p.excluded);
  const truthId = comboIdOf([...store.currentPuzzle.truth]);

  // 排序：真相 / 已选 / 与证据一致且未排除 的卡片始终排在最前，
  // 避免证据收窄后关键候选藏在滚动列表深处。
  const rank = (id: string): number => {
    const isSelected = p.selected === id;
    const isTruth = ended && id === truthId;
    const isCompatible = compatibleSet.has(id);
    const isEx = excludedSet.has(id);
    if (isTruth) return 0;
    if (isSelected) return 1;
    if (isCompatible && !isEx) return 2;
    if (isCompatible && isEx) return 3;
    if (!isCompatible && isEx) return 5;
    return 4;
  };

  const visibleCombos = COMBOS.filter((c) => !(hideExcluded && excludedSet.has(c.id))).sort(
    (a, b) => rank(a.id) - rank(b.id),
  );

  const cards = visibleCombos.map((combo) => {
    const isCompatible = compatibleSet.has(combo.id);
    const isExcluded = excludedSet.has(combo.id);
    const isSelected = p.selected === combo.id;
    const isTruth = ended && combo.id === truthId;
    const isWrongPick = ended && isSelected && p.result && !p.result.correct;

    if (hideExcluded && isExcluded) return null;

    const cls = [
      'combo-card',
      isSelected ? 'selected' : '',
      !isCompatible ? 'incompatible' : '',
      isExcluded ? 'excluded' : '',
      isTruth ? 'truth-card' : '',
      isWrongPick ? 'wrong-card' : '',
    ]
      .filter(Boolean)
      .join('.');

    const statusLine = ended
      ? isTruth
        ? h('span.combo-status.ok', { text: '✓ 真实组合' })
        : isWrongPick
          ? h('span.combo-status.bad', { text: '✗ 你的选择' })
          : isCompatible
            ? h('span.combo-status.ok', { text: '与证据一致' })
            : h('span.combo-status.bad', { text: '证据不符' })
      : isSelected
        ? h('span.combo-status.sel', { text: '◉ 已选为答案' })
        : isExcluded
          ? h('span.combo-status.bad', { text: '已排除（点 ↺ 恢复）' })
          : isCompatible
            ? h('span.combo-status.ok', { text: '◎ 与证据一致' })
            : h('span.combo-status.bad', { text: '证据不符' });

    return h(
      `button.${cls}`,
      {
        type: 'button',
        'aria-pressed': isSelected,
        onClick: () => {
          if (ended) return;
          store.selectCombo(combo.id);
        },
      },
      !ended
        ? h(
            'span.combo-exclude',
            {
              role: 'button',
              title: isExcluded ? '恢复该候选' : '排除该候选（你的手动判断）',
              'aria-label': isExcluded ? '恢复候选' : '排除候选',
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                store.toggleExcluded(combo.id);
              },
            },
            isExcluded ? '↺' : '×',
          )
        : null,
      h(
        'div.combo-plates',
        null,
        combo.plates.map((id) => {
          const plate = PLATE_MAP[id];
          return h(
            'span.combo-plate-line',
            null,
            h('i.dot', { style: `background:${plate.color}` }),
            h('span', { text: plate.name }),
          );
        }),
      ),
      statusLine,
      ended && isTruth
        ? h('span.combo-result-tag', { style: 'color:var(--jade);', text: '真相' })
        : ended && isWrongPick
          ? h('span.combo-result-tag', { style: 'color:var(--vermilion);', text: '误选' })
          : null,
    );
  });

  const selectedCombo = p.selected ? COMBOS.find((c) => c.id === p.selected) : null;

  return h(
    'section.panel.candidates-panel',
    null,
    h(
      'div.panel-head',
      null,
      h('h2', null, h('span.idx', { text: '选' }), '候选组合（6 选 3 · 共 20）'),
    ),
    h(
      'div.candidate-tools',
      null,
      h(
        'label.switch-chip',
        null,
        (() => {
          const cb = h('input', {
            type: 'checkbox',
            checked: hideExcluded ? true : undefined,
            onChange: (e: Event) => {
              hideExcluded = (e.target as HTMLInputElement).checked;
              // 仅重渲染候选区即可；简单起见全局状态未变，手动触发 app 刷新
              window.dispatchEvent(new CustomEvent('ui:toggle-hide-excluded'));
            },
          }) as HTMLInputElement;
          return cb;
        })(),
        '隐藏已排除',
      ),
      h(
        'span.legend',
        null,
        h('span', null, h('i', { style: 'background:var(--jade);' }), '证据一致'),
        h('span', null, h('i', { style: 'background:var(--line-strong);' }), '证据不符'),
        h('span', null, h('i', { style: 'background:var(--vermilion);' }), '已选'),
      ),
    ),
    h('div.combo-grid', null, cards),
    h(
      'div.submit-block',
      null,
      h(
        'div.submit-note',
        {
          text: selectedCombo
            ? `当前选择：${selectedCombo.plates.map((x) => PLATE_MAP[x].name).join(' · ')}`
            : '尚未选择组合',
        },
      ),
      ended
        ? h(
            'button.btn.btn-primary',
            { type: 'button', disabled: true },
            '本题已结束 · 可在上方核对真相',
          )
        : h(
            'button.btn.btn-primary',
            { type: 'button', onClick: () => void handleSubmit() },
            '📜 提交结论',
          ),
      ended
        ? null
        : h(
            'button.btn-danger-ghost',
            { type: 'button', onClick: () => void handleGiveUp() },
            '推理不出来？结束并核对真实摆放',
          ),
    ),
  );
}
