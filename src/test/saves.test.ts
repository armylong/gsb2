import { describe, expect, it } from 'vitest';
import { SAMPLE_DIALOGUE } from '../content/sampleDialogue';
import { createRun, hydrateRun, rewindToBefore, selectChoice } from '../engine/run';
import {
  checkCompatibility,
  configFingerprint,
  createSave,
  readSaves,
  SAVE_STORAGE_KEY,
  upsertSave,
  writeSaves,
} from '../engine/saves';
import type { DialogueConfig, SaveRecord, StorageLike } from '../engine/types';

function advance(choiceIds: string[]) {
  let run = createRun(SAMPLE_DIALOGUE);
  for (const choiceId of choiceIds) {
    const result = selectChoice(run, choiceId, SAMPLE_DIALOGUE);
    expect(result.ok, result.error).toBe(true);
    run = result.run;
  }
  return run;
}

function makeStorage(): StorageLike & { dump(): string | null } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => map.get(SAVE_STORAGE_KEY) ?? null,
  };
}

function saveFrom(run: ReturnType<typeof createRun>, name: string, config = SAMPLE_DIALOGUE) {
  return createSave(
    name,
    {
      nodeId: run.nodeId,
      state: run.state,
      history: run.history,
      abandonedBranches: run.abandonedBranches,
      nextSeq: run.nextSeq,
    },
    config,
    new Date('2026-01-02T03:04:05.000Z'),
  );
}

describe('具名存档与跨页面恢复', () => {
  it('多个具名存档写入存储后能完整读回', () => {
    const run = advance(['to-ticket', 'pay-coins']);
    const run2 = advance(['to-girl', 'give-coin']);
    const storage = makeStorage();

    const saveA = saveFrom(run, '买完票');
    const saveB = saveFrom(run2, '和阿玫坐过');
    writeSaves(storage, upsertSave(upsertSave([], saveA), saveB));

    const reloaded = readSaves(storage);
    expect(reloaded.map((save) => save.name).sort()).toEqual(['买完票', '和阿玫坐过'].sort());

    const restored = hydrateRun(reloaded.find((save) => save.name === '买完票')!.snapshot);
    expect(restored.nodeId).toBe('pier');
    expect(restored.history).toHaveLength(2);
    expect(restored.state.items.coin).toBe(0);
    expect(restored.state.flags.hasTicket).toBe(true);

    const restoredB = hydrateRun(reloaded.find((save) => save.name === '和阿玫坐过')!.snapshot);
    expect(restoredB.nodeId).toBe('girl');
    expect(restoredB.state.stats.affection).toBe(2);
    expect(restoredB.state.items.coin).toBe(2);
  });

  it('存档保留当前分支历史与封存分支，恢复后仍可回溯', () => {
    let run = advance(['to-booth', 'search-drawer']);
    const rewound = rewindToBefore(run, 0, SAMPLE_DIALOGUE);
    expect(rewound.ok).toBe(true);
    run = selectChoice(rewound.run, 'to-ticket', SAMPLE_DIALOGUE).run;

    const save = saveFrom(run, '回溯后');
    expect(save.snapshot.abandonedBranches).toHaveLength(1);
    const storage = makeStorage();
    writeSaves(storage, [save]);
    const restored = hydrateRun(readSaves(storage)[0].snapshot);
    expect(restored.abandonedBranches).toHaveLength(1);
    expect(restored.abandonedBranches[0].entries).toHaveLength(2);
    expect(restored.nodeId).toBe('ticket');
    expect(restored.state.items.coin).toBe(3);
  });

  it('存档是深拷贝，后续运行不会改写已保存的快照', () => {
    const run = advance(['to-ticket']);
    const save = saveFrom(run, '快照');
    run.state.items.coin = 99;
    expect(save.snapshot.state.items.coin).toBe(3);
  });
});

describe('配置变动后的兼容性', () => {
  it('仅修改文本时指纹变化，但存档仍可载入并给出提示', () => {
    const run = advance(['to-ticket']);
    const save = saveFrom(run, '文本改动前');
    const edited: DialogueConfig = {
      ...SAMPLE_DIALOGUE,
      nodes: SAMPLE_DIALOGUE.nodes.map((node) =>
        node.id === 'ticket' ? { ...node, text: '改过的售票窗口台词。' } : node,
      ),
    };
    expect(configFingerprint(edited)).not.toBe(configFingerprint(SAMPLE_DIALOGUE));
    const check = checkCompatibility(save, edited);
    expect(check.ok).toBe(true);
    expect(check.configChanged).toBe(true);
    expect(check.warnings.length).toBeGreaterThan(0);
  });

  it('删除节点后旧存档被拒绝，并指出缺失节点', () => {
    const run = advance(['to-ticket']);
    const save = saveFrom(run, '删节点前');
    const broken: DialogueConfig = {
      ...SAMPLE_DIALOGUE,
      nodes: SAMPLE_DIALOGUE.nodes.filter((node) => node.id !== 'ticket'),
    };
    const check = checkCompatibility(save, broken);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('ticket');
  });

  it('删除历史中的选项后旧存档被拒绝，并指出选项', () => {
    const run = advance(['to-ticket', 'pay-coins']);
    const save = saveFrom(run, '删选项前');
    const broken: DialogueConfig = {
      ...SAMPLE_DIALOGUE,
      nodes: SAMPLE_DIALOGUE.nodes.map((node) =>
        node.id === 'ticket'
          ? { ...node, choices: node.choices.filter((choice) => choice.id !== 'pay-coins') }
          : node,
      ),
    };
    const check = checkCompatibility(save, broken);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('pay-coins');
  });

  it('选项目标被改到别处时旧存档被拒绝', () => {
    const run = advance(['to-ticket']);
    const save = saveFrom(run, '改目标前');
    const edited: DialogueConfig = {
      ...SAMPLE_DIALOGUE,
      nodes: SAMPLE_DIALOGUE.nodes.map((node) =>
        node.id === 'arrival'
          ? {
              ...node,
              choices: node.choices.map((choice) =>
                choice.id === 'to-ticket' ? { ...choice, target: 'booth' } : choice,
              ),
            }
          : node,
      ),
    };
    const check = checkCompatibility(save, edited);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('目标');
  });

  it('存档本身损坏时拒绝载入', () => {
    const run = advance(['to-ticket']);
    const save = saveFrom(run, '损坏');
    const damaged: SaveRecord = {
      ...save,
      snapshot: { ...save.snapshot, nodeId: 'gone', history: [] },
    };
    const check = checkCompatibility(damaged, SAMPLE_DIALOGUE);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain('gone');
  });
});
