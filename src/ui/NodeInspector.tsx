import { RESOURCE_META, recipesForNodeType } from '../engine/recipes';
import { freeSpace, nodeConfig, reservationsTo } from '../engine/engine';
import { STATUS_COLORS, STATUS_LABELS } from './drawing';
import type { SimulationController } from '../state/useSimulation';
import type { ResourceId, SimState, Stock } from '../engine/types';

function StockRows({ stock }: { stock: Stock }) {
  const entries = (Object.keys(stock) as ResourceId[]).filter((r) => stock[r]);
  if (entries.length === 0) return <div className="muted">（无）</div>;
  return (
    <div className="stock-rows">
      {entries.map((r) => (
        <span key={r} className="chip" style={{ borderColor: RESOURCE_META[r].color }}>
          <i style={{ background: RESOURCE_META[r].color }} />
          {RESOURCE_META[r].name} ×{stock[r]}
        </span>
      ))}
    </div>
  );
}

export function NodeInspector({ sim }: { sim: SimulationController }) {
  const state: SimState = sim.getState();
  const id = sim.selectedNodeId;
  if (!id) return <div className="muted hint">点击画布上的节点查看缺料、阻塞与批次进度；点击连线查看运输参数。</div>;
  const cfg = nodeConfig(state, id);
  const rt = state.nodes[id];
  const reserved = reservationsTo(state, id);
  const space = freeSpace(state, id);
  const recipe = cfg.recipeId ? recipesForNodeType(cfg.type).find((r) => r.id === cfg.recipeId) : null;

  return (
    <div className="inspector">
      <div className="inspector-head">
        <h3>{cfg.name}</h3>
        <span className="status-badge" style={{ background: STATUS_COLORS[rt.status] }}>
          {STATUS_LABELS[rt.status]}
        </span>
      </div>

      <div className="kv">
        <div>类型</div>
        <div>{({ miner: '采矿机', smelter: '冶炼炉', assembler: '装配台', warehouse: '仓库' } as const)[cfg.type]}</div>
        <div>容量</div>
        <div>{cfg.capacity}（剩余 {space}）</div>
      </div>

      {rt.active && (
        <section>
          <h4>当前批次（开工时配方已快照）</h4>
          <div className="progress">
            <div
              className="progress-fill"
              style={{ width: `${(1 - rt.active.remainingTicks / rt.active.totalTicks) * 100}%` }}
            />
          </div>
          <div className="muted small">
            配方：{rt.active.recipeSnapshot.name}；剩余 {rt.active.remainingTicks} tick / 共 {rt.active.totalTicks} tick
          </div>
        </section>
      )}

      <section>
        <h4>当前库存</h4>
        <StockRows stock={rt.stock} />
      </section>

      <section>
        <h4>在途预留（别人发给本节点、已占容量）</h4>
        <StockRows stock={reserved} />
      </section>

      {rt.status === 'starved' && (
        <section className="warn">
          <h4>缺料明细</h4>
          <StockRows stock={rt.inspection.missing} />
          {recipe && <div className="muted small">配方需求：{recipe.inputs ? Object.entries(recipe.inputs).map(([k, v]) => `${RESOURCE_META[k as ResourceId].name}×${v}`).join('，') : '无（采矿）'}</div>}
        </section>
      )}

      {rt.status === 'blocked' && (
        <section className="warn">
          <h4>等待输出空间</h4>
          <div className="muted small">待出库产物：</div>
          <StockRows stock={rt.heldOutput} />
          <div className="muted small">容量被以下在途预留占用（来源 → 件数）：</div>
          {Object.keys(rt.inspection.blockedBy).length === 0 ? (
            <div className="muted small">暂无在途，容量被自身库存占满</div>
          ) : (
            <ul className="block-list">
              {Object.entries(rt.inspection.blockedBy).map(([src, n]) => (
                <li key={src}>
                  {nodeConfig(state, src).name} → {n} 件
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {cfg.type !== 'warehouse' && recipe && (
        <section>
          <h4>配方账目</h4>
          <div className="muted small">投入：{Object.keys(recipe.inputs).length ? Object.entries(recipe.inputs).map(([k, v]) => `${RESOURCE_META[k as ResourceId].name}×${v}`).join('，') : '无（采矿）'}</div>
          <div className="muted small">产出：{Object.entries(recipe.outputs).map(([k, v]) => `${RESOURCE_META[k as ResourceId].name}×${v}`).join('，')}</div>
          <div className="muted small">加工时长：{recipe.durationTicks} tick（{recipe.durationTicks * 0.5}s）</div>
        </section>
      )}

      <button className="btn" onClick={() => sim.toggleNodePaused(id)}>
        {cfg.paused ? '恢复运行（在途货物不受影响）' : '暂停该节点（不取消已发出运输）'}
      </button>
    </div>
  );
}
