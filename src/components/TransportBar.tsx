import type { Playback } from '../hooks/usePlayback';
import { clock } from '../lib/format';
import { PauseIcon, PlayIcon, RewindIcon, StepBackIcon, StepForwardIcon } from './Icons';

interface TransportBarProps {
  playback: Playback;
  end: number;
  delay: number;
  onDelayChange: (value: number) => void;
  arrivalCount: number;
}

export function TransportBar({
  playback,
  end,
  delay,
  onDelayChange,
  arrivalCount,
}: TransportBarProps) {
  return (
    <div className="transport">
      <div className="transport__buttons">
        <button
          type="button"
          className="btn btn--icon"
          onClick={playback.restart}
          title="回到开头 (Home)"
          aria-label="回到开头"
        >
          <RewindIcon />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={playback.stepBack}
          title="上一条投递 (Shift + ←)"
          aria-label="上一条投递"
        >
          <StepBackIcon />
        </button>
        <button
          type="button"
          className={`btn btn--play ${playback.playing ? 'is-playing' : ''}`}
          onClick={playback.toggle}
          title="播放 / 暂停 (空格)"
          aria-label={playback.playing ? '暂停' : '播放'}
        >
          {playback.playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          <span>{playback.playing ? '暂停' : playback.time >= end ? '重播' : '播放'}</span>
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={playback.stepForward}
          title="下一条投递 (Shift + →)"
          aria-label="下一条投递"
        >
          <StepForwardIcon />
        </button>
      </div>

      <div className="transport__scrub">
        <input
          className="scrub"
          type="range"
          min={0}
          max={end}
          step={0.05}
          value={Math.min(playback.time, end)}
          onChange={(event) => playback.seek(Number(event.target.value))}
          aria-label="回放时刻"
          aria-valuetext={`${clock(playback.time)}，共 ${clock(end)}`}
          style={{ '--scrub-progress': `${(Math.min(playback.time, end) / end) * 100}%` } as React.CSSProperties}
        />
        <div className="transport__readout">
          <span className="transport__time">
            {clock(playback.time, 2)}
            <span className="transport__time-total"> / {clock(end, 1)}</span>
          </span>
          <span className="transport__hint">
            {arrivalCount} 次到达 · 拖动或按 Shift + ← / → 逐条核对
          </span>
        </div>
      </div>

      <div className="transport__side">
        <label className="field field--inline">
          <span className="field__label">显示延迟</span>
          <input
            className="range range--sm"
            type="range"
            min={0}
            max={8}
            step={0.1}
            value={delay}
            onChange={(event) => onDelayChange(Number(event.target.value))}
            aria-label="显示延迟（秒）"
            style={{ '--scrub-progress': `${(delay / 8) * 100}%` } as React.CSSProperties}
          />
          <span className="field__value">{delay.toFixed(1)}s</span>
        </label>
      </div>
    </div>
  );
}
