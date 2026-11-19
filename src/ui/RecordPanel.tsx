import { useRef, useState } from 'react';
import { ACTIONS, SCENES, isActionId } from '../core/bindings';
import { RecEvent, Recording, ReplayResult, recordingHash, runReplay, validateRecording } from '../core/recording';
import { World } from '../core/world';

export function RecordPanel({ world }: { world: World }) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Recording | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pb = world.playback;

  const loadFile = async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text());
      const result = validateRecording(data);
      if (!result.ok) {
        // 坏录像：提示并保留当前绑定与现场
        setError(`无法打开录像：${result.error}`);
        return;
      }
      setError(null);
      world.recordings.push(result.rec);
    } catch {
      setError('无法打开录像：不是合法的 JSON 文件');
    }
  };

  const saveFile = (rec: Recording) => {
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rec.name.replace(/[^\w一-龥-]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="panel">
      <h2>录制与回放</h2>
      <div className="row">
        {!world.isRecording ? (
          <button className="primary" disabled={!!pb} onClick={() => world.startRecording()}>
            ● 开始录制
          </button>
        ) : (
          <button className="danger" onClick={() => world.stopRecording()}>
            ■ 停止录制（最长 30 秒）
          </button>
        )}
        <button onClick={() => fileRef.current?.click()}>打开录像文件…</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFile(f);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="err small">{error}</div>}

      {pb && (
        <div className="section-gap">
          <h2>回放控制 — {pb.rec.name}</h2>
          <div className="row">
            <button onClick={() => (pb.playing = !pb.playing)} disabled={pb.done}>
              {pb.playing ? '暂停' : '继续'}
            </button>
            <button onClick={() => world.playbackStep()} disabled={pb.done}>
              单步
            </button>
            <select
              value={pb.speed}
              onChange={(e) => (pb.speed = Number(e.target.value))}
              title="播放速度只影响墙钟时间，不影响模拟结果"
            >
              {[0.25, 0.5, 1, 2, 4].map((v) => (
                <option key={v} value={v}>
                  {v}x
                </option>
              ))}
            </select>
            <span className="muted small">
              tick {world.sim.state.tick} / {pb.rec.durationTicks}
            </span>
            <button className="danger" onClick={() => world.stopPlayback()}>
              停止并回到初态
            </button>
          </div>
          {pb.result && <ResultView result={pb.result} />}
        </div>
      )}

      <div className="section-gap">
        {world.recordings.length === 0 && <div className="muted small">暂无录像</div>}
        {world.recordings.map((rec, i) => {
          const verification = world.verificationFor(rec);
          return (
            <div key={i} className="row" style={{ flexWrap: 'wrap' }}>
              <b>{rec.name}</b>
              <span className="muted small">{(rec.durationTicks / 60).toFixed(1)}s / {rec.events.length} 事件</span>
              {verification && (
                <span className={verification.match ? 'ok small' : 'err small'}>
                  {verification.match ? '✓ 校验通过' : `✗ 校验失败（tick ${verification.firstDivergence?.tick}）`}
                </span>
              )}
              <button className="small" disabled={!!pb} onClick={() => world.startPlayback(rec)}>
                回放
              </button>
              <button
                className="small"
                onClick={() => {
                  const r = runReplay(rec);
                  world.verifications.set(recordingHash(rec), r);
                }}
              >
                校验
              </button>
              <button className="small" onClick={() => saveFile(rec)}>
                保存
              </button>
              <button className="small" onClick={() => setEditing(editing === rec ? null : rec)}>
                {editing === rec ? '收起' : '编辑事件'}
              </button>
              <button
                className="small danger"
                onClick={() => world.recordings.splice(world.recordings.indexOf(rec), 1)}
              >
                删除
              </button>
            </div>
          );
        })}
      </div>

      {editing && <EventEditor world={world} rec={editing} />}
    </div>
  );
}

function ResultView({ result }: { result: ReplayResult }) {
  const f = result.final;
  const e = result.expectedFinal;
  return (
    <div className={result.match ? 'ok small' : 'err small'}>
      {result.match ? (
        <>
          与录制结果一致：最终位置 ({f.x.toFixed(1)}, {f.y.toFixed(1)})，交互 {f.interactCount} 次，确认{' '}
          {f.confirmCount} 次；核对点 {result.checkpointsPassed}/{result.checkpointsChecked} 通过。
        </>
      ) : (
        <>
          首个差异出现在 tick {result.firstDivergence?.tick}：期望 (
          {result.firstDivergence?.expected.x.toFixed(1)}, {result.firstDivergence?.expected.y.toFixed(1)})，实际 (
          {result.firstDivergence?.actual.x.toFixed(1)}, {result.firstDivergence?.actual.y.toFixed(1)})。
          最终：期望 ({e.x.toFixed(1)}, {e.y.toFixed(1)}) 交互 {e.interactCount}，实际 ({f.x.toFixed(1)},{' '}
          {f.y.toFixed(1)}) 交互 {f.interactCount}。
        </>
      )}
    </div>
  );
}

/** 编辑录像事件；任何修改都会使旧的校验结果失效（内容哈希变化） */
function EventEditor({ world, rec }: { world: World; rec: Recording }) {
  return (
    <div className="section-gap">
      <h2>事件编辑 — {rec.name}（修改后需重新校验）</h2>
      <div className="log" style={{ height: 160 }}>
        {rec.events.map((ev, i) => (
          <div key={i} className="row" style={{ marginBottom: 2 }}>
            <span className="muted">t={ev.tick}</span>
            <span>{ev.type}</span>
            {ev.type === 'scene' ? (
              <select
                value={ev.scene}
                onChange={(e) =>
                  world.mutateRecording(rec, (evs) => {
                    const t = evs[i] as RecEvent & { type: 'scene' };
                    t.scene = e.target.value as typeof t.scene;
                  })
                }
              >
                {SCENES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={ev.action}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isActionId(v))
                    world.mutateRecording(rec, (evs) => {
                      (evs[i] as RecEvent & { action: string }).action = v;
                    });
                }}
              >
                {ACTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}
            <button
              className="small danger"
              onClick={() => world.mutateRecording(rec, (evs) => void evs.splice(i, 1))}
            >
              删
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
