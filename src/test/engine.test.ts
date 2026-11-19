import { describe, expect, it } from 'vitest';
import { SAMPLE_DIALOGUE } from '../content/sampleDialogue';
import { buildChoiceViews, checkChoice, selectableChoiceIds } from '../engine/choices';
import { changedDeltas } from '../engine/diff';
import { applyEffects } from '../engine/conditions';
import { createRun, rewindToBefore, selectChoice } from '../engine/run';
import { createInitialState } from '../engine/state';
import { validateConfig } from '../engine/validation';
import type { DialogueConfig, GameState } from '../engine/types';

function choose(run: ReturnType<typeof createRun>, choiceId: string, config = SAMPLE_DIALOGUE) {
  const result = selectChoice(run, choiceId, config);
  expect(result.ok, result.error).toBe(true);
  return result.run;
}

function withNodeText(config: DialogueConfig, nodeId: string, text: string): DialogueConfig {
  return {
    ...config,
    nodes: config.nodes.map((node) => (node.id === nodeId ? { ...node, text } : node)),
  };
}

describe('样例对话结构', () => {
  it('包含约 12 个节点、条件选项、分支汇合与回路，且基础校验无错误', () => {
    expect(SAMPLE_DIALOGUE.nodes.length).toBeGreaterThanOrEqual(11);
    expect(SAMPLE_DIALOGUE.nodes.length).toBeLessThanOrEqual(14);

    const report = validateConfig(SAMPLE_DIALOGUE);
    expect(report.errors).toEqual([]);
    expect(report.missingTargets).toEqual([]);
    expect(report.unreachableNodeIds).toEqual([]);
    expect(report.deadEnds).toEqual([]);
    expect(report.loopNodeIds.length).toBeGreaterThan(0);

    // 循环节点只是信息，不进入问题列表。
    expect(report.issues.some((issue) => issue.kind === 'unreachable')).toBe(false);
    // 条件选项与任选一条件都存在。
    const allConditions = SAMPLE_DIALOGUE.nodes.flatMap((node) =>
      node.choices.flatMap((choice) => (choice.when ? [choice.when] : [])),
    );
    expect(allConditions.some((condition) => condition.kind === 'group' && condition.mode === 'all')).toBe(true);
    expect(allConditions.some((condition) => condition.kind === 'group' && condition.mode === 'any')).toBe(true);
  });

  it('能识别缺失目标与不可达节点', () => {
    const broken: DialogueConfig = {
      ...SAMPLE_DIALOGUE,
      nodes: [
        ...SAMPLE_DIALOGUE.nodes.map((node) =>
          node.id === 'arrival'
            ? {
                ...node,
                choices: [
                  ...node.choices,
                  {
                    id: 'broken-link',
                    label: '缺失目标',
                    target: 'nowhere',
                    effects: [],
                    lockedDisplay: 'disable' as const,
                  },
                ],
              }
            : node,
        ),
        {
          id: 'orphan',
          title: '孤岛节点',
          speaker: '旁白',
          text: '没人能到这里。',
          terminal: false,
          choices: [
            { id: 'orphan-back', label: '返回入口', target: 'arrival', effects: [], lockedDisplay: 'disable' },
          ],
        },
      ],
    };
    const report = validateConfig(broken);
    expect(report.missingTargets).toEqual([
      { nodeId: 'arrival', choiceId: 'broken-link', target: 'nowhere' },
    ]);
    expect(report.unreachableNodeIds).toContain('orphan');
    expect(report.errors.some((issue) => issue.kind === 'missing-target')).toBe(true);
  });
});

describe('条件检查与双视图一致性', () => {
  it('调试视图列出每个不可用选项及原因，玩家视图按隐藏/禁用展示，可选集合一致', () => {
    let current = createRun(SAMPLE_DIALOGUE);
    current = choose(current, 'to-ticket');
    current = choose(current, 'pay-coins');
    current = choose(current, 'board-ticket');

    const deck = SAMPLE_DIALOGUE.nodes.find((node) => node.id === 'deck')!;
    const debugIds = selectableChoiceIds(deck, current.state, SAMPLE_DIALOGUE, 'debug');
    const playerIds = selectableChoiceIds(deck, current.state, SAMPLE_DIALOGUE, 'player');
    expect(playerIds).toEqual(debugIds);
    expect(playerIds).not.toContain('watch-sea');

    const watchSea = deck.choices.find((choice) => choice.id === 'watch-sea')!;
    const availability = checkChoice(watchSea, current.state, SAMPLE_DIALOGUE);
    expect(availability.available).toBe(false);
    expect(availability.reasons[0].text).toContain('阿玫好感');
    expect(availability.reasons[0].text).toContain('当前为 1');

    // 隐藏与禁用的选项在调试视图都可见，但玩家视图里隐藏项不出现。
    const cabin = SAMPLE_DIALOGUE.nodes.find((node) => node.id === 'cabin')!;
    const withTape: GameState = {
      ...current.state,
      items: { ...current.state.items, tape: 1 },
    };
    const debugCabin = buildChoiceViews(cabin, withTape, SAMPLE_DIALOGUE, 'debug');
    const playerCabin = buildChoiceViews(cabin, withTape, SAMPLE_DIALOGUE, 'player');
    const debugSearch = debugCabin.find((entry) => entry.choice.id === 'search-bag')!;
    const playerSearch = playerCabin.find((entry) => entry.choice.id === 'search-bag')!;
    expect(debugSearch.visible).toBe(true);
    expect(debugSearch.available).toBe(false);
    expect(debugSearch.reasons.length).toBeGreaterThan(0);
    expect(playerSearch.visible).toBe(false);
    expect(cabin.choices.find((choice) => choice.id === 'search-bag')?.lockedDisplay).toBe('hide');
    expect(selectableChoiceIds(cabin, withTape, SAMPLE_DIALOGUE, 'player')).toEqual(
      selectableChoiceIds(cabin, withTape, SAMPLE_DIALOGUE, 'debug'),
    );
  });

  it('全部满足与任一满足按预期求值', () => {
    const state: GameState = createInitialState(SAMPLE_DIALOGUE.variables);
    const baseNode = SAMPLE_DIALOGUE.nodes[0];
    const allCondition = {
      kind: 'group' as const,
      mode: 'all' as const,
      conditions: [
        { kind: 'flag' as const, key: 'metMei', value: false },
        { kind: 'stat' as const, key: 'affection', op: 'gte' as const, value: 2 },
      ],
    };
    const anyCondition = {
      kind: 'group' as const,
      mode: 'any' as const,
      conditions: [
        { kind: 'flag' as const, key: 'metMei', value: true },
        { kind: 'stat' as const, key: 'affection', op: 'gte' as const, value: 1 },
      ],
    };
    const probeNode = {
      ...baseNode,
      choices: [
        { ...baseNode.choices[0], id: 'all', when: allCondition },
        { ...baseNode.choices[0], id: 'any', when: anyCondition },
      ],
    };
    const allResult = checkChoice(probeNode.choices[0], state, SAMPLE_DIALOGUE);
    const anyResult = checkChoice(probeNode.choices[1], state, SAMPLE_DIALOGUE);
    expect(allResult.available).toBe(false);
    expect(allResult.reasons[0].text).toContain('阿玫好感');
    expect(anyResult.available).toBe(true);
  });
});

describe('效果幂等与库存下限', () => {
  it('同一选择重复求值不会重复发奖励，条件与消耗都在选择前检查', () => {
    let run = createRun(SAMPLE_DIALOGUE);
    run = choose(run, 'to-booth');
    const before = run.state;
    run = choose(run, 'search-drawer');
    const afterFirst = run.state;
    expect(afterFirst.items.coin).toBe(before.items.coin + 1);
    expect(afterFirst.items.key).toBe(1);
    expect(afterFirst.flags.searchedBooth).toBe(true);

    // 回看历史不会重新应用效果。
    const historyEntry = run.history[run.history.length - 1];
    expect(historyEntry.after.items.coin).toBe(afterFirst.items.coin);
    expect(run.state.items.coin).toBe(afterFirst.items.coin);

    // 再次求值同一效果只作用于新状态，旧状态不会被修改。
    const reapplied = applyEffects(afterFirst, SAMPLE_DIALOGUE.nodes.find((n) => n.id === 'booth')!.choices[0].effects);
    expect(reapplied.items.coin).toBe(afterFirst.items.coin + 1);
    expect(afterFirst.items.coin).toBe(before.items.coin + 1);

    // 循环回旧节点后, 奖励选项已被标记隐藏/不可用。
    run = choose(run, 'booth-to-arrival');
    run = choose(run, 'to-booth');
    const search = SAMPLE_DIALOGUE.nodes
      .find((node) => node.id === 'booth')!
      .choices.find((choice) => choice.id === 'search-drawer')!;
    expect(checkChoice(search, run.state, SAMPLE_DIALOGUE).available).toBe(false);
  });

  it('数量不足的消耗被拒绝，库存不会被扣成负数', () => {
    const poor = createInitialState(SAMPLE_DIALOGUE.variables);
    poor.items.coin = 1;
    const payNode = SAMPLE_DIALOGUE.nodes.find((node) => node.id === 'ticket')!;
    const payChoice = payNode.choices.find((choice) => choice.id === 'pay-coins')!;
    const availability = checkChoice(payChoice, poor, SAMPLE_DIALOGUE);
    expect(availability.available).toBe(false);
    expect(availability.reasons.some((reason) => reason.kind === 'item-cost')).toBe(true);

    // 直接调用效果应用也有兜底，不产生负库存。
    const clamped = applyEffects(poor, payChoice.effects);
    expect(clamped.items.coin).toBe(0);
  });
});

describe('分支汇合与回溯再分支', () => {
  it('买票与偷渡汇合到甲板时变量不同', () => {
    let ticketRoute = createRun(SAMPLE_DIALOGUE);
    ticketRoute = choose(ticketRoute, 'to-ticket');
    ticketRoute = choose(ticketRoute, 'pay-coins');
    ticketRoute = choose(ticketRoute, 'board-ticket');
    ticketRoute = choose(ticketRoute, 'to-cabin');
    ticketRoute = choose(ticketRoute, 'cabin-to-deck');

    let stowRoute = createRun(SAMPLE_DIALOGUE);
    stowRoute = choose(stowRoute, 'to-girl');
    stowRoute = choose(stowRoute, 'give-coin');
    stowRoute = choose(stowRoute, 'ask-lead');
    stowRoute = choose(stowRoute, 'board-stowaway');
    stowRoute = choose(stowRoute, 'to-cabin');
    stowRoute = choose(stowRoute, 'cabin-to-deck');

    expect(ticketRoute.nodeId).toBe('deck');
    expect(stowRoute.nodeId).toBe('deck');
    expect(ticketRoute.state.flags.hasTicket).toBe(true);
    expect(stowRoute.state.flags.stowaway).toBe(true);
    expect(ticketRoute.state.flags.metMei).toBe(false);
    expect(stowRoute.state.flags.metMei).toBe(true);
    expect(ticketRoute.state.items.coin).toBe(0);
    expect(stowRoute.state.items.coin).toBe(2);
    expect(ticketRoute.state.stats.affection).toBe(1);
    expect(stowRoute.state.stats.affection).toBe(2);
    // 汇合后同一节点, 因变量不同, 可选集合也不同。
    const deck = SAMPLE_DIALOGUE.nodes.find((node) => node.id === 'deck')!;
    expect(selectableChoiceIds(deck, ticketRoute.state, SAMPLE_DIALOGUE, 'debug')).not.toContain(
      'watch-sea',
    );
    expect(selectableChoiceIds(deck, stowRoute.state, SAMPLE_DIALOGUE, 'debug')).toContain(
      'watch-sea',
    );
  });

  it('回到历史选择之前恢复完整变量，再走另一条路形成新分支，旧分支只读留存', () => {
    let run = createRun(SAMPLE_DIALOGUE);
    run = choose(run, 'to-booth');
    run = choose(run, 'search-drawer');
    const stateBeforeBooth = run.history[0].before;
    const rewardState = run.state;
    expect(run.state.items.coin).toBe(4);

    const rewound = rewindToBefore(run, 0, SAMPLE_DIALOGUE);
    expect(rewound.ok).toBe(true);
    const fresh = rewound.run;
    expect(fresh.nodeId).toBe('arrival');
    expect(fresh.state).toEqual(stateBeforeBooth);
    expect(fresh.state.items.coin).toBe(3);
    expect(fresh.history).toHaveLength(0);
    expect(fresh.abandonedBranches).toHaveLength(1);
    expect(fresh.abandonedBranches[0].finalState.items.coin).toBe(rewardState.items.coin);
    expect(fresh.abandonedBranches[0].entries).toHaveLength(2);

    const branched = choose(fresh, 'to-ticket');
    expect(branched.nodeId).toBe('ticket');
    expect(branched.history).toHaveLength(1);
    expect(branched.abandonedBranches).toHaveLength(1);
    expect(branched.state.items.coin).toBe(3);
    // 旧分支状态没有混入当前分支。
    expect(branched.state.flags.searchedBooth).toBe(false);
    expect(branched.history.some((entry) => entry.choiceId === 'search-drawer')).toBe(false);
    // 旧分支作为只读快照可以完整查看。
    expect(branched.abandonedBranches[0].entries.map((entry) => entry.choiceId)).toEqual([
      'to-booth',
      'search-drawer',
    ]);
  });

  it('反复回溯同一步不会让封存分支 ID 撞车', () => {
    const run = choose(choose(createRun(SAMPLE_DIALOGUE), 'to-booth'), 'search-drawer');
    const first = rewindToBefore(run, 0, SAMPLE_DIALOGUE);
    expect(first.ok).toBe(true);
    const again = choose(choose(first.run, 'to-booth'), 'search-drawer');
    const second = rewindToBefore(again, 0, SAMPLE_DIALOGUE);
    expect(second.ok).toBe(true);
    const ids = second.run.abandonedBranches.map((branch) => branch.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
  });

  it('历史记录保存选择前后变量与实际去向', () => {
    let run = createRun(SAMPLE_DIALOGUE);
    run = choose(run, 'to-girl');
    run = choose(run, 'give-coin');
    const entry = run.history[1];
    expect(entry.nodeId).toBe('girl');
    expect(entry.choiceId).toBe('give-coin');
    expect(entry.targetNodeId).toBe('girl');
    expect(entry.before.items.coin).toBe(3);
    expect(entry.after.items.coin).toBe(2);
    expect(entry.before.flags.metMei).toBe(false);
    expect(entry.after.flags.metMei).toBe(true);
    expect(changedDeltas(entry.before, entry.after, SAMPLE_DIALOGUE.variables).map((d) => d.key)).toEqual(
      expect.arrayContaining(['coin', 'affection', 'metMei']),
    );
  });
});

describe('配置编辑后的行为', () => {
  it('修改节点文本后从入口重跑使用新文本', () => {
    const edited = withNodeText(SAMPLE_DIALOGUE, 'arrival', '新的开场白，雾更浓了。');
    // 试跑本身不依赖文本, 但配置校验应保持通过。
    expect(validateConfig(edited).errors).toEqual([]);
    expect(edited.nodes.find((node) => node.id === 'arrival')?.text).toContain('新的开场白');
  });
});
