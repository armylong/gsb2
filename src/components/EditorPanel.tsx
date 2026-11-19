import type {
  CompareOp,
  Condition,
  DialogueChoice,
  DialogueConfig,
  DialogueNode,
  Effect,
  VariableCatalog,
} from '../engine/types';

interface EditorPanelProps {
  config: DialogueConfig;
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onPatchNode: (nodeId: string, patch: Partial<DialogueNode>) => void;
  onPatchChoice: (nodeId: string, choiceId: string, patch: Partial<DialogueChoice>) => void;
  onRestart: () => void;
  onResetConfig: () => void;
  dirty: boolean;
}

type LeafKind = 'flag' | 'stat' | 'item';

function flattenLeaves(condition: Condition | undefined): { mode: 'none' | 'all' | 'any'; leaves: Condition[] } {
  if (!condition) return { mode: 'none', leaves: [] };
  if (condition.kind === 'group') {
    return {
      mode: condition.mode,
      leaves: condition.conditions.filter((child) => child.kind !== 'group'),
    };
  }
  return { mode: 'all', leaves: [condition] };
}

function rebuildCondition(
  mode: 'none' | 'all' | 'any',
  leaves: Condition[],
): Condition | undefined {
  if (mode === 'none' || leaves.length === 0) return undefined;
  if (leaves.length === 1 && mode === 'all') return leaves[0];
  return { kind: 'group', mode, conditions: leaves };
}

function defaultLeaf(catalog: VariableCatalog): Condition {
  if (catalog.flags.length > 0) {
    return { kind: 'flag', key: catalog.flags[0].key, value: true };
  }
  if (catalog.stats.length > 0) {
    return { kind: 'stat', key: catalog.stats[0].key, op: 'gte', value: 1 };
  }
  return { kind: 'item', key: catalog.items[0]?.key ?? 'coin', op: 'gte', value: 1 };
}

function keysFor(catalog: VariableCatalog, kind: LeafKind): string[] {
  if (kind === 'flag') return catalog.flags.map((entry) => entry.key);
  if (kind === 'stat') return catalog.stats.map((entry) => entry.key);
  return catalog.items.map((entry) => entry.key);
}

function labelFor(catalog: VariableCatalog, kind: LeafKind, key: string): string {
  const pool =
    kind === 'flag' ? catalog.flags : kind === 'stat' ? catalog.stats : catalog.items;
  return pool.find((entry) => entry.key === key)?.label ?? key;
}

function ConditionEditor({
  condition,
  catalog,
  onChange,
}: {
  condition: Condition | undefined;
  catalog: VariableCatalog;
  onChange: (next: Condition | undefined) => void;
}) {
  const { mode, leaves } = flattenLeaves(condition);

  const setLeaf = (index: number, leaf: Condition) => {
    const next = leaves.map((entry, i) => (i === index ? leaf : entry));
    onChange(rebuildCondition(mode, next));
  };

  return (
    <div className="condition-editor">
      <label className="mini-field">
        <span>条件组合</span>
        <select
          value={mode}
          onChange={(event) => {
            const nextMode = event.target.value as 'none' | 'all' | 'any';
            if (nextMode === 'none') {
              onChange(undefined);
              return;
            }
            const nextLeaves = leaves.length > 0 ? leaves : [defaultLeaf(catalog)];
            onChange(rebuildCondition(nextMode, nextLeaves));
          }}
        >
          <option value="none">无条件</option>
          <option value="all">全部满足</option>
          <option value="any">任一满足</option>
        </select>
      </label>

      {mode !== 'none'
        ? leaves.map((leaf, index) => {
            const kind: LeafKind = leaf.kind === 'group' ? 'flag' : leaf.kind;
            const leafKey = leaf.kind === 'group' ? '' : leaf.key;
            const isFlag = leaf.kind === 'flag';
            const leafOp: CompareOp = leaf.kind === 'stat' || leaf.kind === 'item' ? leaf.op : 'gte';
            const leafValue: number =
              leaf.kind === 'stat' || leaf.kind === 'item' ? leaf.value : 0;
            return (
              <div key={index} className="leaf-condition">
                <select
                  aria-label={`条件 ${index + 1} 类型`}
                  value={kind}
                  onChange={(event) =>
                    setLeaf(index, defaultLeafOfKind(catalog, event.target.value as LeafKind))
                  }
                >
                  <option value="flag">标记</option>
                  <option value="stat">好感</option>
                  <option value="item">物品</option>
                </select>
                <select
                  aria-label={`条件 ${index + 1} 变量`}
                  value={leafKey}
                  onChange={(event) => {
                    if (kind === 'flag') {
                      setLeaf(index, { kind: 'flag', key: event.target.value, value: true });
                    } else {
                      setLeaf(index, { kind, key: event.target.value, op: leafOp, value: leafValue });
                    }
                  }}
                >
                  {keysFor(catalog, kind).map((key) => (
                    <option key={key} value={key}>
                      {labelFor(catalog, kind, key)}
                    </option>
                  ))}
                </select>
                {isFlag ? (
                  <select
                    aria-label={`条件 ${index + 1} 取值`}
                    value={leaf.kind === 'flag' && leaf.value ? 'true' : 'false'}
                    onChange={(event) =>
                      setLeaf(index, {
                        kind: 'flag',
                        key: leafKey,
                        value: event.target.value === 'true',
                      })
                    }
                  >
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <>
                    <select
                      aria-label={`条件 ${index + 1} 比较`}
                      value={leafOp}
                      onChange={(event) =>
                        setLeaf(index, {
                          kind: kind as 'stat' | 'item',
                          key: leafKey,
                          op: event.target.value as CompareOp,
                          value: leafValue,
                        })
                      }
                    >
                      <option value="gte">≥</option>
                      <option value="lte">≤</option>
                      <option value="gt">&gt;</option>
                      <option value="lt">&lt;</option>
                      <option value="eq">=</option>
                      <option value="ne">≠</option>
                    </select>
                    <input
                      aria-label={`条件 ${index + 1} 数值`}
                      type="number"
                      value={leafValue}
                      onChange={(event) =>
                        setLeaf(index, {
                          kind: kind as 'stat' | 'item',
                          key: leafKey,
                          op: leafOp,
                          value: Number(event.target.value),
                        })
                      }
                    />
                  </>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除条件 ${index + 1}`}
                  onClick={() => {
                    const next = leaves.filter((_, i) => i !== index);
                    onChange(rebuildCondition(mode, next));
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        : null}

      {mode !== 'none' ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() => onChange(rebuildCondition(mode, [...leaves, defaultLeaf(catalog)]))}
        >
          + 添加条件项
        </button>
      ) : null}
    </div>
  );
}

function defaultLeafOfKind(catalog: VariableCatalog, kind: LeafKind): Condition {
  const key = keysFor(catalog, kind)[0] ?? '';
  if (kind === 'flag') return { kind: 'flag', key, value: true };
  return { kind, key, op: 'gte', value: 1 };
}

function EffectEditor({
  effects,
  catalog,
  onChange,
}: {
  effects: Effect[];
  catalog: VariableCatalog;
  onChange: (next: Effect[]) => void;
}) {
  const setEffect = (index: number, effect: Effect) => {
    onChange(effects.map((entry, i) => (i === index ? effect : entry)));
  };
  return (
    <div className="effect-editor">
      {effects.map((effect, index) => {
        const kind = effect.kind;
        const key = effect.key;
        return (
          <div key={index} className="leaf-condition">
            <select
              aria-label={`效果 ${index + 1} 类型`}
              value={kind}
              onChange={(event) => {
                const nextKind = event.target.value as LeafKind;
                const nextKey = keysFor(catalog, nextKind)[0] ?? '';
                setEffect(
                  index,
                  nextKind === 'flag'
                    ? { kind: 'flag', key: nextKey, value: true }
                    : { kind: nextKind, key: nextKey, delta: 1 },
                );
              }}
            >
              <option value="flag">标记</option>
              <option value="stat">好感</option>
              <option value="item">物品</option>
            </select>
            <select
              aria-label={`效果 ${index + 1} 变量`}
              value={key}
              onChange={(event) => {
                if (kind === 'flag') {
                  setEffect(index, { kind, key: event.target.value, value: (effect as { value: boolean }).value });
                } else {
                  setEffect(index, {
                    kind,
                    key: event.target.value,
                    delta: (effect as { delta: number }).delta,
                  });
                }
              }}
            >
              {keysFor(catalog, kind).map((entry) => (
                <option key={entry} value={entry}>
                  {labelFor(catalog, kind, entry)}
                </option>
              ))}
            </select>
            {kind === 'flag' ? (
              <select
                aria-label={`效果 ${index + 1} 取值`}
                value={(effect as { value: boolean }).value ? 'true' : 'false'}
                onChange={(event) =>
                  setEffect(index, { kind: 'flag', key, value: event.target.value === 'true' })
                }
              >
                <option value="true">设为是</option>
                <option value="false">设为否</option>
              </select>
            ) : (
              <input
                aria-label={`效果 ${index + 1} 增量`}
                type="number"
                value={(effect as { delta: number }).delta}
                onChange={(event) =>
                  setEffect(index, { kind, key, delta: Number(event.target.value) })
                }
              />
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`删除效果 ${index + 1}`}
              onClick={() => onChange(effects.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="ghost-button"
        onClick={() =>
          onChange([
            ...effects,
            { kind: 'stat', key: catalog.stats[0]?.key ?? 'affection', delta: 1 },
          ])
        }
      >
        + 添加效果
      </button>
    </div>
  );
}

export function EditorPanel({
  config,
  selectedNodeId,
  onSelectNode,
  onPatchNode,
  onPatchChoice,
  onRestart,
  onResetConfig,
  dirty,
}: EditorPanelProps) {
  const node = config.nodes.find((entry) => entry.id === selectedNodeId) ?? config.nodes[0];

  return (
    <div className="editor" data-testid="editor-panel">
      <div className="editor-top">
        <label className="mini-field">
          <span>编辑节点</span>
          <select value={node?.id ?? ''} onChange={(event) => onSelectNode(event.target.value)}>
            {config.nodes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}（{entry.id}）
              </option>
            ))}
          </select>
        </label>
        <div className="editor-actions">
          <button type="button" className="primary-button primary-button--sm" onClick={onRestart}>
            按当前配置重新开始
          </button>
          <button type="button" className="ghost-button" onClick={onResetConfig}>
            还原示例配置
          </button>
        </div>
      </div>

      {node ? (
        <div className="editor-body">
          <div className="editor-grid">
            <label className="mini-field">
              <span>节点标题</span>
              <input
                value={node.title}
                onChange={(event) => onPatchNode(node.id, { title: event.target.value })}
              />
            </label>
            <label className="mini-field">
              <span>说话人</span>
              <input
                value={node.speaker}
                onChange={(event) => onPatchNode(node.id, { speaker: event.target.value })}
              />
            </label>
          </div>
          <label className="mini-field">
            <span>节点文本</span>
            <textarea
              rows={3}
              value={node.text}
              onChange={(event) => onPatchNode(node.id, { text: event.target.value })}
            />
          </label>

          <div className="editor-choices">
            {node.choices.map((choice) => (
              <details key={choice.id} className="editor-choice">
                <summary>
                  <span>{choice.label}</span>
                  <code>{choice.id}</code>
                </summary>
                <div className="editor-choice-body">
                  <div className="editor-grid">
                    <label className="mini-field">
                      <span>选项文字</span>
                      <input
                        value={choice.label}
                        onChange={(event) =>
                          onPatchChoice(node.id, choice.id, { label: event.target.value })
                        }
                      />
                    </label>
                    <label className="mini-field">
                      <span>目标节点</span>
                      <select
                        value={choice.target}
                        onChange={(event) =>
                          onPatchChoice(node.id, choice.id, { target: event.target.value })
                        }
                      >
                        {config.nodes.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.title}（{entry.id}）
                          </option>
                        ))}
                        {!config.nodes.some((entry) => entry.id === choice.target) ? (
                          <option value={choice.target}>{choice.target}（缺失）</option>
                        ) : null}
                      </select>
                    </label>
                    <label className="mini-field">
                      <span>不可用时</span>
                      <select
                        value={choice.lockedDisplay}
                        onChange={(event) =>
                          onPatchChoice(node.id, choice.id, {
                            lockedDisplay: event.target.value as 'disable' | 'hide',
                          })
                        }
                      >
                        <option value="disable">禁用并显示</option>
                        <option value="hide">隐藏</option>
                      </select>
                    </label>
                  </div>

                  <div className="editor-section-label">条件（选择前检查）</div>
                  <ConditionEditor
                    condition={choice.when}
                    catalog={config.variables}
                    onChange={(next) => onPatchChoice(node.id, choice.id, { when: next })}
                  />

                  <div className="editor-section-label">效果（选择时执行一次）</div>
                  <EffectEditor
                    effects={choice.effects}
                    catalog={config.variables}
                    onChange={(next) => onPatchChoice(node.id, choice.id, { effects: next })}
                  />
                </div>
              </details>
            ))}
          </div>

          {dirty ? (
            <p className="notice notice--soft">
              配置已修改，并已自动保存为本地草稿。修改后旧存档若引用已删除的节点或选项，会在存档面板中标记为不兼容并拒绝载入。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="empty-note">配置中没有节点。</p>
      )}
    </div>
  );
}
