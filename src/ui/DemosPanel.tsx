import { DEMOS } from '../core/demos';
import { World } from '../core/world';

export function DemosPanel({ world }: { world: World }) {
  return (
    <div className="panel">
      <h2>内置演示</h2>
      {DEMOS.map((d) => (
        <div key={d.id} className="row" style={{ alignItems: 'flex-start' }}>
          <button onClick={() => d.apply(world)}>{d.name}</button>
          <span className="muted small" style={{ flex: 1 }}>
            {d.description}
          </span>
        </div>
      ))}
      <div className="row section-gap">
        <button
          onClick={() => {
            world.stopPlayback();
            world.stopRecording();
            world.engine.clearAll();
            world.sim.reset({ scene: 'game' });
            if (world.engine.scene !== 'game') world.engine.setScene('game');
            world.log = [];
          }}
        >
          一键回到初态
        </button>
        <span className="muted small">停止录制/回放，重置角色与场景（保留当前绑定）</span>
      </div>
    </div>
  );
}
