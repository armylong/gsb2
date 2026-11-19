import { useEffect, useState } from 'react';
import {
  ACTIONS,
  ACTION_MAP,
  ActionId,
  SCENE_LABEL,
  SceneId,
  cloneBindings,
  defaultBindings,
  findConflict,
} from '../core/bindings';
import { Chord, chordLabel, unreliableReason } from '../core/keys';
import { World } from '../core/world';
import { CaptureRequest } from './App';

interface PendingConflict {
  scene: SceneId;
  action: ActionId;
  chord: Chord;
  conflictWith: ActionId;
}

export function BindingsPanel({
  world,
  capture,
  onCaptureChange,
}: {
  world: World;
  capture: CaptureRequest | null;
  onCaptureChange: (c: CaptureRequest | null) => void;
}) {
  const [scene, setScene] = useState<SceneId>('game');
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // 捕获完成（App 在捕获状态下把按键路由到这里）
  useEffect(() => {
    const onCaptured = (e: Event) => {
      const { scene: sc, action, chord } = (e as CustomEvent).detail as CaptureRequest & { chord: Chord };
      const unreliable = unreliableReason(chord);
      const conflictWith = findConflict(world.engine.bindings, sc, action, chord);
      if (conflictWith) {
        setConflict({ scene: sc, action, chord, conflictWith });
        setWarning(null);
        return;
      }
      applyBinding(world, sc, action, chord);
      setWarning(unreliable ? `注意：${chordLabel(chord)} —— ${unreliable}，该绑定可能永远不会触发。` : null);
    };
    window.addEventListener('sandbox:captured', onCaptured);
    return () => window.removeEventListener('sandbox:captured', onCaptured);
  }, [world]);

  const bindings = world.engine.bindings;

  return (
    <div className="panel">
      <h2>键位绑定</h2>
      <div className="tabs">
        {(['game', 'menu'] as SceneId[]).map((sc) => (
          <button key={sc} className={scene === sc ? 'active' : ''} onClick={() => setScene(sc)}>
            {SCENE_LABEL[sc]}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => {
            world.engine.bindings = defaultBindings();
            world.handleBlur();
            setWarning(null);
            setConflict(null);
          }}
        >
          全部恢复默认
        </button>
      </div>

      {capture && (
        <div className="capture-box">
          正在捕获：<b>{ACTION_MAP[capture.action].label}</b>（{SCENE_LABEL[capture.scene]}）
          <div className="small muted">请按下要绑定的键或组合键（可含 Shift/Ctrl/Alt/Cmd）。Esc 取消并保留旧绑定。捕获期间按键不会控制角色。</div>
          <button className="small" onClick={() => onCaptureChange(null)}>
            取消
          </button>
        </div>
      )}

      {conflict && (
        <div className="capture-box">
          <div>
            <span className="chord">{chordLabel(conflict.chord)}</span> 已绑定给「
            {ACTION_MAP[conflict.conflictWith].label}」（同场景）。
          </div>
          <div className="row section-gap">
            <button
              className="danger"
              onClick={() => {
                const map = cloneBindings(world.engine.bindings);
                map[conflict.scene][conflict.conflictWith] = null; // 替换：清掉旧占用
                map[conflict.scene][conflict.action] = conflict.chord;
                world.engine.bindings = map;
                world.handleBlur();
                const unreliable = unreliableReason(conflict.chord);
                setWarning(unreliable ? `注意：${chordLabel(conflict.chord)} —— ${unreliable}。` : null);
                setConflict(null);
              }}
            >
              替换（原动作解绑）
            </button>
            <button onClick={() => setConflict(null)}>取消（保留原绑定）</button>
          </div>
        </div>
      )}

      {warning && <div className="warn small">{warning}</div>}

      <table>
        <tbody>
          {ACTIONS.map((a) => {
            const chord = bindings[scene][a.id];
            const unreliable = chord ? unreliableReason(chord) : null;
            return (
              <tr key={a.id}>
                <td>
                  {a.label}
                  <span className="muted small">（{a.kind === 'continuous' ? '持续' : '边沿'}）</span>
                  <div className="muted small">{a.hint[scene]}</div>
                </td>
                <td>
                  {chord ? (
                    <span className="chord" title={unreliable ?? undefined}>
                      {chordLabel(chord)}
                      {unreliable && <span className="warn"> ⚠</span>}
                    </span>
                  ) : (
                    <span className="chord unbound">未绑定</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className="small"
                    disabled={!!world.playback}
                    onClick={() => {
                      onCaptureChange({ scene, action: a.id });
                      setConflict(null);
                    }}
                  >
                    重绑
                  </button>{' '}
                  <button
                    className="small"
                    disabled={!!world.playback || !chord}
                    onClick={() => {
                      const map = cloneBindings(bindings);
                      map[scene][a.id] = null;
                      world.engine.bindings = map;
                      world.handleBlur();
                    }}
                  >
                    清除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function applyBinding(world: World, scene: SceneId, action: ActionId, chord: Chord) {
  const map = cloneBindings(world.engine.bindings);
  map[scene][action] = chord;
  world.engine.bindings = map;
  world.handleBlur(); // 改键后释放按住状态，避免残留
}
