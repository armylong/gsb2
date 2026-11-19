import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SAMPLE_DIALOGUE } from './content/sampleDialogue';
import { changedDeltas } from './engine/diff';
import { createRun, hydrateRun, restartRun, rewindToBefore, selectChoice } from './engine/run';
import {
  checkCompatibility,
  configFingerprint,
  createSave,
  readSaves,
  upsertSave,
  writeSaves,
} from './engine/saves';
import type {
  CompatibilityResult,
  DialogueConfig,
  DialogueNode,
  RunState,
  SaveRecord,
  StorageLike,
} from './engine/types';
import { validateConfig } from './engine/validation';
import { ChoiceList } from './components/ChoiceList';
import { DialogueGraph } from './components/DialogueGraph';
import { EditorPanel } from './components/EditorPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { SavePanel } from './components/SavePanel';
import { Section } from './components/Section';
import { ValidationPanel } from './components/ValidationPanel';
import { VariablesPanel } from './components/VariablesPanel';
import {
  clearDraftConfig,
  getBrowserStorage,
  loadDraftConfig,
  persistDraftConfig,
} from './app/storage';

type FlashTone = 'ok' | 'warn' | 'error';

interface Flash {
  tone: FlashTone;
  text: string;
}

/** 存储不可用时的内存替身，保证本次页面内仍能保存/载入。 */
function createMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

export default function App() {
  const [browserStorage] = useState<StorageLike | null>(() => getBrowserStorage());
  const [storage] = useState<StorageLike>(() => browserStorage ?? createMemoryStorage());
  const [boot] = useState(() => {
    const draft = loadDraftConfig(browserStorage);
    return { config: draft ?? SAMPLE_DIALOGUE, dirty: Boolean(draft) };
  });

  const [config, setConfig] = useState<DialogueConfig>(boot.config);
  const [dirty, setDirty] = useState(boot.dirty);
  const [run, setRun] = useState<RunState>(() => createRun(boot.config));
  const [note, setNote] = useState<Flash | null>(null);
  const [rewindNotice, setRewindNotice] = useState<string | null>(null);
  const [inspectedBranchId, setInspectedBranchId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState(boot.config.entryNodeId);

  const [saves, setSaves] = useState<SaveRecord[]>(() => readSaves(storage));
  const [saveName, setSaveName] = useState('');
  const [saveMessage, setSaveMessage] = useState<Flash | null>(null);
  const [historyViewIndex, setHistoryViewIndex] = useState<number | null>(null);

  const noteTimer = useRef<number | null>(null);
  const noteRef = useRef<Flash | null>(null);
  noteRef.current = note;

  useEffect(() => {
    return () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    };
  }, []);

  useEffect(() => {
    if (dirty) persistDraftConfig(browserStorage, config);
  }, [config, dirty, browserStorage]);

  const flash = useCallback((next: Flash) => {
    setNote(next);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 6000);
  }, []);

  const validation = useMemo(() => validateConfig(config), [config]);

  /** 历史查看模式下的只读运行态；变量取那一步选择之前的快照。 */
  const shownRun: RunState = useMemo(() => {
    if (historyViewIndex === null) return run;
    const entry = run.history[historyViewIndex];
    if (!entry) return run;
    return {
      nodeId: entry.nodeId,
      state: entry.before,
      history: run.history.slice(0, historyViewIndex),
      abandonedBranches: run.abandonedBranches,
      nextSeq: run.nextSeq,
    };
  }, [run, historyViewIndex]);

  const node: DialogueNode | undefined = config.nodes.find(
    (entry) => entry.id === shownRun.nodeId,
  );
  const liveNode: DialogueNode | undefined = config.nodes.find((entry) => entry.id === run.nodeId);

  const lastDelta = useMemo(() => {
    const last = run.history[run.history.length - 1];
    return last ? changedDeltas(last.before, last.after, config.variables) : [];
  }, [run.history, config.variables]);

  const visitedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of run.history) {
      ids.add(entry.nodeId);
      ids.add(entry.targetNodeId);
    }
    ids.add(run.nodeId);
    return ids;
  }, [run]);

  const compatibility = useCallback(
    (save: SaveRecord): CompatibilityResult => checkCompatibility(save, config),
    [config],
  );

  const configStillCoversRun = useMemo(() => {
    const byId = new Map(config.nodes.map((entry) => [entry.id, entry]));
    if (!byId.has(run.nodeId)) return false;
    return run.history.every((entry) => {
      const historyNode = byId.get(entry.nodeId);
      return Boolean(historyNode?.choices.some((choice) => choice.id === entry.choiceId));
    });
  }, [run, config]);

  const handleChoice = (choiceId: string) => {
    if (historyViewIndex !== null) {
      flash({ tone: 'warn', text: '正在查看历史记录。先“返回当前进度”，再做新的选择。' });
      return;
    }
    const result = selectChoice(run, choiceId, config);
    if (!result.ok) {
      flash({ tone: 'error', text: result.error ?? '选择失败' });
      return;
    }
    const entry = result.run.history[result.run.history.length - 1];
    setRun(result.run);
    setSaveMessage(null);
    const deltas = changedDeltas(entry.before, entry.after, config.variables);
    flash({
      tone: 'ok',
      text:
        deltas.length === 0
          ? `已选择「${entry.choiceLabel}」，变量无变化 → ${entry.targetNodeTitle}`
          : `已选择「${entry.choiceLabel}」：${deltas
              .map((delta) => `${delta.label} ${delta.before}→${delta.after}`)
              .join('，')} → ${entry.targetNodeTitle}`,
    });
  };

  const handleRewind = (index: number) => {
    const entry = run.history[index];
    const result = rewindToBefore(run, index, config);
    if (!result.ok) {
      flash({ tone: 'error', text: result.error ?? '无法回溯' });
      return;
    }
    setRun(result.run);
    setHistoryViewIndex(null);
    setInspectedBranchId(null);
    setRewindNotice(
      `已回到第 #${entry.seq} 次选择「${entry.choiceLabel}」之前。该选择及其后的路径已封存为只读分支，新的选择会形成新分支。`,
    );
    flash({ tone: 'ok', text: '回溯完成：节点与变量已恢复到该选择之前。' });
  };

  const handleInspectHistory = (index: number) => {
    setHistoryViewIndex(index);
    flash({
      tone: 'warn',
      text: `正在查看第 #${run.history[index]?.seq ?? '?'} 次选择之前的状态（只读）。`,
    });
  };

  const handleRestart = () => {
    setRun(restartRun(config));
    setHistoryViewIndex(null);
    setInspectedBranchId(null);
    setRewindNotice(null);
    setSaveMessage(null);
    flash({ tone: 'ok', text: '已按当前配置从入口重新开始，变量回到初始值。' });
  };

  const handleSave = () => {
    const save = createSave(
      saveName || `存档 ${saves.length + 1}`,
      {
        nodeId: run.nodeId,
        state: run.state,
        history: run.history,
        abandonedBranches: run.abandonedBranches,
        nextSeq: run.nextSeq,
      },
      config,
    );
    const next = upsertSave(saves, save);
    try {
      writeSaves(storage, next);
      setSaves(next);
      setSaveName('');
      setSaveMessage({
        tone: 'ok',
        text: browserStorage
          ? `已保存「${save.name}」。刷新页面后仍可载入。`
          : `已保存「${save.name}」（浏览器存储不可用，仅本次页面有效）。`,
      });
    } catch {
      setSaveMessage({ tone: 'error', text: '写入存储失败，当前进度未落盘。' });
    }
  };

  const handleLoad = (save: SaveRecord) => {
    const check = checkCompatibility(save, config);
    if (!check.ok) {
      setSaveMessage({
        tone: 'error',
        text: `拒绝载入「${save.name}」：${check.problems.join('；')}。当前现场已保留。`,
      });
      return;
    }
    const restored = hydrateRun(save.snapshot);
    setRun(restored);
    setHistoryViewIndex(null);
    setInspectedBranchId(null);
    setRewindNotice(null);
    setSaveMessage({
      tone: 'ok',
      text: `已载入「${save.name}」：节点 ${restored.nodeId}，历史 ${restored.history.length} 步，变量已恢复${check.warnings.length > 0 ? '（配置有变动）' : ''}。`,
    });
  };

  const handleDelete = (save: SaveRecord) => {
    const next = saves.filter((entry) => entry.id !== save.id);
    try {
      writeSaves(storage, next);
      setSaves(next);
      setSaveMessage({ tone: 'ok', text: `已删除存档「${save.name}」。` });
    } catch {
      setSaveMessage({ tone: 'error', text: '删除存档时写入失败。' });
    }
  };

  const patchNode = (nodeId: string, patch: Partial<DialogueNode>) => {
    setConfig((current) => ({
      ...current,
      nodes: current.nodes.map((entry) => (entry.id === nodeId ? { ...entry, ...patch } : entry)),
    }));
    setDirty(true);
  };

  const patchChoice = (
    nodeId: string,
    choiceId: string,
    patch: Partial<DialogueNode['choices'][number]>,
  ) => {
    setConfig((current) => ({
      ...current,
      nodes: current.nodes.map((entry) =>
        entry.id === nodeId
          ? {
              ...entry,
              choices: entry.choices.map((choice) =>
                choice.id === choiceId ? { ...choice, ...patch } : choice,
              ),
            }
          : entry,
      ),
    }));
    setDirty(true);
  };

  const handleResetConfig = () => {
    setConfig(SAMPLE_DIALOGUE);
    setDirty(false);
    clearDraftConfig(browserStorage);
    setSelectedNodeId(SAMPLE_DIALOGUE.entryNodeId);
    flash({ tone: 'ok', text: '已还原内置示例配置；现有存档会按新配置重新校验兼容性。' });
  };

  const fingerprint = configFingerprint(config);
  const graphNodeId = node?.id ?? run.nodeId;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="app-eyebrow">本地分支对话调试器 · 无需联网</p>
          <h1>{config.title}</h1>
          <p className="app-subtitle">{config.subtitle}</p>
        </div>
        <div className="header-status">
          <span className="status-chip" title={fingerprint}>
            配置 <code>{fingerprint.slice(0, 15)}…</code>
          </span>
          <span className="status-chip">
            节点 {config.nodes.length} · 记录 {run.history.length}
          </span>
          <span className={`status-chip ${configStillCoversRun ? '' : 'status-chip--warn'}`}>
            {configStillCoversRun ? '现场与配置一致' : '现场引用了已变更配置'}
          </span>
        </div>
      </header>

      <div className="notice-stack" aria-live="polite">
        {note ? <p className={`notice notice--${note.tone}`}>{note.text}</p> : null}
        {rewindNotice ? (
          <p className="notice notice--info">
            {rewindNotice}{' '}
            <button type="button" className="link-button" onClick={() => setRewindNotice(null)}>
              知道了
            </button>
          </p>
        ) : null}
        {validation.errors.length > 0 ? (
          <p className="notice notice--warn">
            配置检查发现 {validation.errors.length} 个错误、{validation.warnings.length} 个警告。试跑仍可进行，但请先查看右侧检查结果。
          </p>
        ) : null}
      </div>

      <main className="dashboard">
        <Section
          title="节点关系"
          eyebrow="点击节点可在下方编辑区定位；选择仍从对话面板进行"
          className="graph-panel"
        >
          <DialogueGraph
            config={config}
            currentNodeId={graphNodeId}
            validation={validation}
            visitedNodeIds={visitedNodeIds}
            onSelectNode={setSelectedNodeId}
          />
        </Section>

        <div className="top-grid">
          <Section
            title="当前对话"
            eyebrow={node ? `${node.speaker} · ${node.id}` : '节点缺失'}
            actions={
              historyViewIndex !== null ? (
                <button
                  type="button"
                  className="primary-button primary-button--sm"
                  onClick={() => setHistoryViewIndex(null)}
                >
                  返回当前进度
                </button>
              ) : (
                <button type="button" className="ghost-button" onClick={handleRestart}>
                  从头开始
                </button>
              )
            }
          >
            {node ? (
              <>
                {historyViewIndex !== null ? (
                  <p className="notice notice--soft">
                    历史快照只读：显示的是做出该选择之前的对话与变量。
                  </p>
                ) : null}
                <div className="dialogue-card" data-testid="dialogue-card">
                  <div className="dialogue-meta">
                    <span className="speaker">{node.speaker}</span>
                    <span className="node-tag">{node.title}</span>
                    {node.terminal ? <span className="badge badge--terminal">结局</span> : null}
                  </div>
                  <p className="dialogue-text">{node.text}</p>
                </div>
                {node.terminal || node.choices.length === 0 ? (
                  <div className="ending-panel">
                    <h3>{node.terminal ? '流程结束' : '没有可用出口'}</h3>
                    <p>
                      {node.terminal
                        ? '可以回溯到任意历史选择之前，或保存当前存档后换一条路。'
                        : '该节点没有任何选项，请检查配置。'}
                    </p>
                  </div>
                ) : null}
                {node.choices.length > 0 && !node.terminal ? (
                  <ChoiceList
                    node={node}
                    state={shownRun.state}
                    config={config}
                    onSelect={handleChoice}
                    readOnly={historyViewIndex !== null}
                  />
                ) : null}
                <HistoryPanel
                  history={run.history}
                  branches={run.abandonedBranches}
                  catalog={config.variables}
                  onRewind={handleRewind}
                  onInspect={handleInspectHistory}
                  inspectingIndex={historyViewIndex}
                  onInspectBranch={setInspectedBranchId}
                  inspectedBranchId={inspectedBranchId}
                />
              </>
            ) : (
              <p className="empty-note">
                当前节点「{shownRun.nodeId}」在配置中找不到。请载入兼容存档或从头开始。
              </p>
            )}
          </Section>

          <aside className="side-stack">
            <Section
              title="当前变量"
              eyebrow={
                historyViewIndex !== null
                  ? '历史快照（只读）'
                  : lastDelta.length > 0
                    ? '高亮为上一步的变化'
                    : '实时状态'
              }
            >
              <VariablesPanel
                catalog={config.variables}
                state={shownRun.state}
                previousState={
                  historyViewIndex === null && run.history.length > 0
                    ? run.history[run.history.length - 1].before
                    : undefined
                }
              />
            </Section>

            <Section title="存档" eyebrow="存放在浏览器 localStorage">
              <SavePanel
                saves={saves}
                saveName={saveName}
                onSaveNameChange={setSaveName}
                onSave={handleSave}
                onLoad={handleLoad}
                onDelete={handleDelete}
                compatibility={compatibility}
                storageAvailable={Boolean(browserStorage)}
                message={saveMessage}
              />
            </Section>

            <Section title="配置检查" eyebrow="缺失目标 / 循环 / 不可达">
              <ValidationPanel report={validation} onFocusNode={setSelectedNodeId} />
            </Section>
          </aside>
        </div>
      </main>

      <Section
        title="配置编辑与试跑"
        eyebrow="少量文本、条件与效果即可改完重跑"
        className="editor-section"
      >
        <EditorPanel
          config={config}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          onPatchNode={patchNode}
          onPatchChoice={patchChoice}
          onRestart={handleRestart}
          onResetConfig={handleResetConfig}
          dirty={dirty}
        />
      </Section>

      <footer className="app-footer">
        <p>
          条件从调试视图可见；玩家视图按“隐藏 / 禁用”设置展示，两者的可选结论来自同一套求值函数。
          所有效果只在一次选择中执行一次，重复渲染、切换视图与回看记录都不会再次发放。
        </p>
        <p className="footer-meta">
          {liveNode?.terminal ? `终点 ${liveNode.title}` : `当前节点 ${run.nodeId}`} · 配置指纹{' '}
          {fingerprint} · 封存分支 {run.abandonedBranches.length}
        </p>
      </footer>
    </div>
  );
}
