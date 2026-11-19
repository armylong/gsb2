export function PlaybackBar({
  playing,
  speed,
  cursor,
  total,
  time,
  horizon,
  jumpInput,
  onJumpInput,
  onPlayToggle,
  onStep,
  onStepBack,
  onNextEvent,
  onSeekTime,
  onSpeed,
  onReset,
  dead,
  requestedTime,
}: {
  playing: boolean;
  speed: number;
  cursor: number;
  total: number;
  time: number;
  horizon: number;
  jumpInput: string;
  onJumpInput: (value: string) => void;
  onPlayToggle: () => void;
  onStep: () => void;
  onStepBack: () => void;
  onNextEvent: () => void;
  onSeekTime: (time: number) => void;
  onSpeed: (speed: number) => void;
  onReset: () => void;
  dead: boolean;
  requestedTime: number | null;
}) {
  const presets = [0, 1000, 2000, 3000, 4500, 6000, 9000, 12000, 30000];

  function applyJump() {
    const raw = jumpInput.trim();
    if (!raw) return;
    const value = raw.endsWith('s') ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
    if (Number.isFinite(value)) onSeekTime(value);
  }

  return (
    <div className="card playback">
      <div className="transport">
        <button className="primary" onClick={onPlayToggle} aria-label={playing ? '暂停' : '运行'}>
          {playing ? '❚❚ 暂停' : '▶ 运行'}
        </button>
        <button className="ghost" onClick={onStepBack} disabled={cursor < 0} title="上一条结算">
          ⏴ 上一步
        </button>
        <button className="ghost" onClick={onStep} disabled={cursor >= total - 1} title="下一条结算">
          下一步 ⏵
        </button>
        <button className="ghost" onClick={onNextEvent} title="跳到下一个用户事件时刻">
          下一事件 ⏭
        </button>
        <button className="ghost" onClick={onReset} title="回到初始状态">
          ⟲ 重置
        </button>
        <label className="speed">
          速度
          <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
            {[0.5, 1, 2, 4].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <div className="time-readout">
          <strong>{Math.round(time)}</strong>
          <span>ms</span>
          {dead && <span className="badge danger">目标死亡</span>}
        </div>
        <div className="record-readout">
          结算 {cursor + 1} / {total}
        </div>
      </div>

      <div className="seek-row">
        <span className="muted seek-label">定位</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={horizon}
          step={50}
          value={Math.max(0, Math.min(horizon, Math.round(time)))}
          onChange={(event) => onSeekTime(Number(event.target.value))}
          aria-label="时间进度"
        />
        <div className="jump">
          <input
            className="jump-input"
            value={jumpInput}
            onChange={(event) => onJumpInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyJump();
            }}
            placeholder="跳转 e.g. 2500 或 2.5s"
            aria-label="跳转到指定时间（毫秒或秒）"
          />
          <button className="ghost" onClick={applyJump}>
            跳转
          </button>
        </div>
      </div>
      <div className="presets">
        {presets.map((preset) => (
          <button
            key={preset}
            className={Math.round(time) === preset ? 'chip active' : 'chip'}
            onClick={() => onSeekTime(preset)}
          >
            {preset === 0 ? '0' : preset === horizon ? '30s' : `${(preset / 1000).toFixed(1).replace(/\.0$/, '')}s`}
          </button>
        ))}
      </div>
      <p className="muted tiny">
        运行/单步按已结算记录推进（单步粒度到护盾吸收/每一跳）；定位与跳转取该时刻全部结算完成后的状态，与连续运行一致，不会重复触发。
        {requestedTime !== null && Math.round(requestedTime) !== Math.round(time) && (
          <span className="seek-hint">
            已请求 {Math.round(requestedTime)}ms，最近一次结算完成于 {Math.round(time)}ms
          </span>
        )}
      </p>
    </div>
  );
}
