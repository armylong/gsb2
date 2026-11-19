import { ACTION_MAP } from '../core/bindings';
import { World } from '../core/world';
import { keyLabel } from '../core/keys';

/** 实时状态：实际按下的物理键、解析出的动作、触发日志 */
export function LivePanel({ world }: { world: World }) {
  const pressed = [...world.engine.getPressed()];
  const active = [...world.engine.getActive().keys()];
  const s = world.sim.state;
  return (
    <div className="panel">
      <h2>实时输入</h2>
      <div className="row">
        <span className="muted">场景</span>
        <span className="badge on">{s.scene === 'game' ? '游戏' : '菜单'}</span>
        {s.paused && <span className="badge warn">已暂停</span>}
        {world.isRecording && <span className="badge err">录制中</span>}
        {world.playback && <span className="badge on">回放中</span>}
        <button
          className="small"
          onClick={() => world.setScene(s.scene === 'game' ? 'menu' : 'game')}
          disabled={!!world.playback}
        >
          切换到{s.scene === 'game' ? '菜单' : '游戏'}
        </button>
      </div>
      <div className="row">
        <span className="muted">按下的键</span>
        <div className="kbd-list">
          {pressed.length === 0 && <span className="muted">（无）</span>}
          {pressed.map((c) => (
            <span key={c} className="chord">
              {keyLabel(c)}
            </span>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="muted">激活动作</span>
        <div className="kbd-list">
          {active.length === 0 && <span className="muted">（无）</span>}
          {active.map((a) => (
            <span key={a} className="chord">
              {ACTION_MAP[a].label}
            </span>
          ))}
        </div>
      </div>
      <h2 className="section-gap">触发日志</h2>
      <div className="log">
        {world.log.length === 0 && <div className="muted">（暂无）</div>}
        {[...world.log].reverse().map((l, i) => (
          <div key={i}>
            <span className="muted">[{String(l.tick).padStart(5, ' ')}]</span> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
