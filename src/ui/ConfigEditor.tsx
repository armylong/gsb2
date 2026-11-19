import { useState } from 'react';
import { recipesForNodeType } from '../engine/recipes';
import { cloneConfig } from '../engine/engine';
import type { ConnectionConfig, NodeConfig, SimConfig } from '../engine/types';

interface Props {
  config: SimConfig;
  onApply: (config: SimConfig) => void;
}

export function ConfigEditor({ config, onApply }: Props) {
  const [draft, setDraft] = useState<SimConfig>(() => cloneConfig(config));
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 外部场景切换时重新载入草稿。
  const sourceKey = config.nodes.map((n) => n.id).join('|') + config.connections.map((c) => c.id).join('|');
  const [lastKey, setLastKey] = useState(sourceKey);
  if (sourceKey !== lastKey) {
    setLastKey(sourceKey);
    setDraft(cloneConfig(config));
    setVersion((v) => v + 1);
  }

  const mutate = (fn: (d: SimConfig) => void) => {
    const next = cloneConfig(draft);
    fn(next);
    setDraft(next);
    setVersion((v) => v + 1);
    setError(null);
  };

  const updateNode = (id: string, patch: Partial<NodeConfig>) =>
    mutate((d) => {
      const n = d.nodes.find((x) => x.id === id)!;
      Object.assign(n, patch);
    });

  const updateConn = (id: string, patch: Partial<ConnectionConfig>) =>
    mutate((d) => {
      const c = d.connections.find((x) => x.id === id)!;
      Object.assign(c, patch);
    });

  const removeConnection = (id: string) =>
    mutate((d) => {
      d.connections = d.connections.filter((c) => c.id !== id);
    });

  const addConnection = (from: string, to: string) =>
    mutate((d) => {
      if (from === to) {
        setError('不能建立自环连接');
        return;
      }
      const id = `c${Date.now().toString(36)}`;
      d.connections.push({ id, from, to, transportTicks: 4, maxInFlight: 2, enabled: true });
    });

  const [newFrom, setNewFrom] = useState(draft.nodes[0]?.id ?? '');
  const [newTo, setNewTo] = useState(draft.nodes[1]?.id ?? '');

  return (
    <div className="config-editor" key={version}>
      <h4>节点参数（修改后点“应用并重置”生效）</h4>
      {draft.nodes.map((n) => (
        <div className="edit-card" key={n.id}>
          <div className="edit-title">
            <input
              value={n.name}
              onChange={(e) => updateNode(n.id, { name: e.target.value })}
              aria-label={`节点 ${n.id} 名称`}
            />
            <label className="inline">
              <input
                type="checkbox"
                checked={n.paused}
                onChange={(e) => updateNode(n.id, { paused: e.target.checked })}
              />
              暂停
            </label>
          </div>
          <div className="edit-grid">
            {n.type !== 'warehouse' && (
              <label>
                配方
                <select
                  value={n.recipeId ?? ''}
                  onChange={(e) => updateNode(n.id, { recipeId: e.target.value || null })}
                >
                  <option value="">（无）</option>
                  {recipesForNodeType(n.type).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}（{r.durationTicks}t）
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              容量
              <input
                type="number"
                min={1}
                value={n.capacity}
                onChange={(e) => updateNode(n.id, { capacity: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
          </div>
        </div>
      ))}

      <h4>连接参数</h4>
      {draft.connections.map((c) => {
        const from = draft.nodes.find((n) => n.id === c.from)!;
        const to = draft.nodes.find((n) => n.id === c.to)!;
        return (
          <div className="edit-card" key={c.id}>
            <div className="edit-title">
              <span className="conn-name">{from.name} → {to.name}</span>
              <button className="btn-mini danger" onClick={() => removeConnection(c.id)}>
                移除
              </button>
            </div>
            <div className="edit-grid">
              <label>
                运输 tick
                <input
                  type="number"
                  min={1}
                  value={c.transportTicks}
                  onChange={(e) =>
                    updateConn(c.id, { transportTicks: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </label>
              <label>
                最大在途批次
                <input
                  type="number"
                  min={1}
                  value={c.maxInFlight}
                  onChange={(e) =>
                    updateConn(c.id, { maxInFlight: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </label>
            </div>
          </div>
        );
      })}

      <h4>新增连接</h4>
      <div className="add-conn">
        <select value={newFrom} onChange={(e) => setNewFrom(e.target.value)}>
          {draft.nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </select>
        <span>→</span>
        <select value={newTo} onChange={(e) => setNewTo(e.target.value)}>
          {draft.nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </select>
        <button className="btn-mini" onClick={() => addConnection(newFrom, newTo)}>
          添加
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="editor-actions">
        <button className="btn primary" onClick={() => onApply(draft)}>
          应用并重置模拟
        </button>
        <button className="btn" onClick={() => { setDraft(cloneConfig(config)); setError(null); }}>
          放弃修改
        </button>
      </div>
      <p className="muted small">
        提示：配方时长/容量/运输参数都会真实改变节拍与阻塞；初始库存请在重置后的场景文件中调整，
        或通过选择场景重新载入。
      </p>
    </div>
  );
}
