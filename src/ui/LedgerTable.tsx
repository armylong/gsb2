import { ALL_RESOURCES, RESOURCE_META, stockTotal } from '../engine/recipes';
import {
  verifyCounterSum,
  verifyGlobalLedger,
  verifyNodeLedger,
} from '../engine/engine';
import type { SimState } from '../engine/types';

/** 每种资源一行：初始 / 消耗 / 产出 / 发货 / 到货 / 当前库存 / 在途，并附守恒核对结果。 */
export function LedgerTable({ state }: { state: SimState }) {
  const global = verifyGlobalLedger(state);
  const nodes = verifyNodeLedger(state);
  const sum = verifyCounterSum(state);
  const allOk = global.ok && nodes.ok && sum.ok;

  const initialByRes = Object.fromEntries(
    ALL_RESOURCES.map((r) => [
      r,
      state.config.nodes.reduce((acc, n) => acc + (n.initialStock[r] ?? 0), 0),
    ]),
  ) as Record<string, number>;

  const inTransitByRes = Object.fromEntries(
    ALL_RESOURCES.map((r) => [
      r,
      state.shipments.reduce((acc, s) => acc + (s.cargo[r] ?? 0), 0),
    ]),
  ) as Record<string, number>;

  const heldByRes = Object.fromEntries(
    ALL_RESOURCES.map((r) => [
      r,
      state.config.nodes.reduce(
        (acc, n) => acc + (state.nodes[n.id].heldOutput[r] ?? 0),
        0,
      ),
    ]),
  ) as Record<string, number>;

  const stockByRes = Object.fromEntries(
    ALL_RESOURCES.map((r) => [
      r,
      state.config.nodes.reduce(
        (acc, n) => acc + (state.nodes[n.id].stock[r] ?? 0),
        0,
      ),
    ]),
  ) as Record<string, number>;

  return (
    <div className="ledger">
      <div className={`ledger-status ${allOk ? 'ok' : 'bad'}`}>
        {allOk ? '✓ 账目核对通过（全局守恒 + 节点守恒 + 计数汇总）' : '✗ 账目不平'}
        {!allOk && (
          <ul>
            {[...global.failures, ...nodes.failures, ...sum.failures].map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>资源</th>
            <th>初始</th>
            <th>开工消耗</th>
            <th>加工产出</th>
            <th>累计发货</th>
            <th>累计到货</th>
            <th>节点库存</th>
            <th>待出库</th>
            <th>在途</th>
          </tr>
        </thead>
        <tbody>
          {ALL_RESOURCES.map((r) => (
            <tr key={r}>
              <td>
                <i className="dot" style={{ background: RESOURCE_META[r].color }} />
                {RESOURCE_META[r].name}
              </td>
              <td>{initialByRes[r]}</td>
              <td>{state.ledger.consumed[r] ?? 0}</td>
              <td>{state.ledger.produced[r] ?? 0}</td>
              <td>{state.ledger.shipped[r] ?? 0}</td>
              <td>{state.ledger.delivered[r] ?? 0}</td>
              <td>{stockByRes[r]}</td>
              <td>{heldByRes[r]}</td>
              <td>{inTransitByRes[r]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        守恒式：初始 + 产出 − 消耗 = 节点库存 + 待出库 + 在途。
        当前全图实体总量 {totalEntities(state)} 件，其中在途 {inTransitTotal(state)} 件。
      </div>
    </div>
  );
}

function inTransitTotal(state: SimState): number {
  return state.shipments.reduce((a, s) => a + stockTotal(s.cargo), 0);
}

function totalEntities(state: SimState): number {
  let n = 0;
  for (const cfg of state.config.nodes) {
    const rt = state.nodes[cfg.id];
    n += stockTotal(rt.stock) + stockTotal(rt.heldOutput);
  }
  n += state.shipments.reduce((a, s) => a + stockTotal(s.cargo), 0);
  return n;
}
