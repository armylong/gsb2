import { describe, expect, it } from 'vitest';
import { SAMPLE_DIALOGUE } from '../content/sampleDialogue';
import { validateConfig } from '../engine/validation';
import type { DialogueConfig, DialogueNode } from '../engine/types';

function node(overrides: Partial<DialogueNode> & { id: string }): DialogueNode {
  return {
    title: overrides.id,
    speaker: '旁白',
    text: '…',
    terminal: false,
    choices: [],
    position: { col: 0, row: 0 },
    ...overrides,
  };
}

function config(nodes: DialogueNode[], entryNodeId = nodes[0]?.id ?? 'entry'): DialogueConfig {
  return {
    schemaVersion: 1,
    id: 'validation-fixture',
    title: 'fixture',
    subtitle: 'fixture',
    entryNodeId,
    variables: SAMPLE_DIALOGUE.variables,
    nodes,
  };
}

describe('配置检查清单', () => {
  it('列出缺失目标、死路与从入口不可达的节点', () => {
    const report = validateConfig(
      config([
        node({
          id: 'entry',
          choices: [
            { id: 'broken', label: '坏链接', target: 'nowhere', effects: [], lockedDisplay: 'disable' },
            { id: 'to-dead', label: '去死路', target: 'dead', effects: [], lockedDisplay: 'disable' },
          ],
        }),
        node({ id: 'dead' }),
        node({
          id: 'orphan',
          choices: [{ id: 'orphan-exit', label: '离开', target: 'entry', effects: [], lockedDisplay: 'disable' }],
        }),
        node({ id: 'ending', terminal: true }),
      ]),
    );

    expect(report.missingTargets).toEqual([
      { nodeId: 'entry', choiceId: 'broken', target: 'nowhere' },
    ]);
    expect(report.deadEnds).toEqual(['dead']);
    expect(report.unreachableNodeIds).toContain('orphan');
    expect(report.errors.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['missing-target', 'dead-end', 'unreachable']),
    );
  });

  it('提示所有出口都带条件的节点，且这种节点不进“缺失目标”', () => {
    const report = validateConfig(
      config([
        node({
          id: 'entry',
          choices: [
            {
              id: 'locked',
              label: '需要好感',
              target: 'ending',
              when: { kind: 'stat', key: 'affection', op: 'gte', value: 99 },
              effects: [],
              lockedDisplay: 'disable',
            },
          ],
        }),
        node({ id: 'ending', terminal: true }),
      ]),
    );
    expect(report.noUnconditionalExitNodeIds).toEqual(['entry']);
    expect(report.missingTargets).toEqual([]);
    expect(report.issues.some((issue) => issue.kind === 'no-unconditional-exit')).toBe(true);
  });

  it('列出无法抵达任何结局的节点（含无条件可选的滞留节点）', () => {
    const report = validateConfig(
      config([
        node({
          id: 'entry',
          choices: [
            { id: 'loop-a', label: '去 A', target: 'a', effects: [], lockedDisplay: 'disable' },
          ],
        }),
        node({
          id: 'a',
          choices: [{ id: 'back', label: '回入口', target: 'entry', effects: [], lockedDisplay: 'disable' }],
        }),
        node({ id: 'ending', terminal: true }),
      ]),
    );
    expect(report.noPathToEndingNodeIds).toEqual(['entry', 'a']);
    expect(report.reachableEndingIds).toEqual([]);
    expect(report.issues.some((issue) => issue.kind === 'no-path-to-ending')).toBe(true);
  });

  it('有意设计的循环不被判定为坏图，只列入循环节点', () => {
    const report = validateConfig(SAMPLE_DIALOGUE);
    expect(report.errors).toEqual([]);
    expect(report.loopNodeIds).toContain('girl');
    expect(report.loopNodeIds).toContain('booth');
    expect(report.loopNodeIds).toContain('radio');
    // 循环不会出现在问题列表里。
    expect(report.issues.some((issue) => issue.kind === 'unreachable')).toBe(false);
    expect(report.issues.some((issue) => issue.kind === 'no-path-to-ending')).toBe(false);
  });

  it('没有结局或入口缺失时给出错误', () => {
    const noEnding = validateConfig(
      config([
        node({
          id: 'entry',
          choices: [{ id: 'self', label: '自循环', target: 'entry', effects: [], lockedDisplay: 'disable' }],
        }),
      ]),
    );
    expect(noEnding.errors.some((issue) => issue.kind === 'no-reachable-ending')).toBe(true);

    const noEntry = validateConfig(config([node({ id: 'ending', terminal: true })], 'missing'));
    expect(noEntry.errors.some((issue) => issue.kind === 'missing-entry')).toBe(true);
  });

  it('未声明的变量只产生警告，不阻断试跑', () => {
    const report = validateConfig(
      config([
        node({
          id: 'entry',
          choices: [
            {
              id: 'typo',
              label: '打错变量名',
              target: 'ending',
              when: { kind: 'stat', key: 'affectoin', op: 'gte', value: 1 },
              effects: [{ kind: 'item', key: 'coinz', delta: 1 }],
              lockedDisplay: 'disable',
            },
          ],
        }),
        node({ id: 'ending', terminal: true }),
      ]),
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter((issue) => issue.kind === 'unknown-variable')).toHaveLength(2);
  });
});
