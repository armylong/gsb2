import type { SimulationController, Speed } from '../state/useSimulation';
import { tickToSeconds } from '../engine/engine';

const SPEEDS: Speed[] = [1, 2, 4, 8];

export function Toolbar({ sim }: { sim: SimulationController }) {
  const state = sim.getState();
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {sim.running ? (
          <button className="btn" onClick={sim.pause}>⏸ 暂停</button>
        ) : (
          <button className="btn primary" onClick={sim.play}>▶ 运行</button>
        )}
        <button className="btn" onClick={() => sim.stepOnce(1)}>
          单步 +1 tick（0.5s）
        </button>
        <button className="btn" onClick={() => sim.stepOnce(4)}>
          单步 +4 tick（2s）
        </button>
        <button className="btn" onClick={() => sim.reset()}>↺ 重置</button>
      </div>
      <div className="toolbar-group">
        <span className="muted small">倍率</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`btn-mini ${sim.speed === s ? 'active' : ''}`}
            onClick={() => sim.setSpeed(s)}
          >
            ×{s}
          </button>
        ))}
      </div>
      <div className="toolbar-clock">
        <div>tick <b>{state.tick}</b></div>
        <div>模拟时长 <b>{tickToSeconds(state.tick).toFixed(1)}s</b></div>
        <div>在途 <b>{state.shipments.length}</b> 批</div>
      </div>
    </div>
  );
}
