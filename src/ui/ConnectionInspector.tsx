import type { SimulationController } from '../state/useSimulation';

export function ConnectionInspector({ sim }: { sim: SimulationController }) {
  const state = sim.getState();
  const id = sim.selectedConnectionId;
  if (!id) return null;
  const conn = state.config.connections.find((c) => c.id === id)!;
  const from = state.config.nodes.find((n) => n.id === conn.from)!;
  const to = state.config.nodes.find((n) => n.id === conn.to)!;
  const inFlight = state.shipments.filter((s) => s.connectionId === id);

  return (
    <div className="inspector">
      <div className="inspector-head">
        <h3>
          {from.name} → {to.name}
        </h3>
        <span className={`status-badge ${conn.enabled ? '' : 'off'}`}>{conn.enabled ? '启用中' : '已停用'}</span>
      </div>
      <div className="kv">
        <div>运输时间</div>
        <div>{conn.transportTicks} tick（{conn.transportTicks * 0.5}s）</div>
        <div>最大在途批次</div>
        <div>{conn.maxInFlight}</div>
        <div>当前在途</div>
        <div>{inFlight.length} 批</div>
      </div>
      <div className="muted small">
        停用连接只停止新发货；下列在途货物仍会送到原目标，不会退回或消失。
      </div>
      <ul className="block-list">
        {inFlight.map((s) => (
          <li key={s.id}>
            货物#{s.id}，第 {s.arriveAt} tick 到达（还剩 {s.arriveAt - state.tick} tick）
          </li>
        ))}
        {inFlight.length === 0 && <li className="muted">当前无在途货物</li>}
      </ul>
      <button className="btn" onClick={() => sim.setConnectionEnabled(id, !conn.enabled)}>
        {conn.enabled ? '停用连接（在途继续送达）' : '重新启用连接'}
      </button>
    </div>
  );
}
