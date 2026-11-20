import { TIME_SCALES } from '../studio/store';
import type { StudioSnapshot } from '../studio/store';

interface TransportProps {
  state: StudioSnapshot;
  actions: {
    toggleRun: () => void;
    step: () => void;
    reset: () => void;
    setTimeScale: (scale: number) => void;
    enterPreview: () => void;
    exitPreview: () => void;
    togglePreviewPlay: () => void;
  };
}

export function Transport({ state, actions }: TransportProps) {
  const preview = state.mode === 'preview';
  return (
    <div className={`transport ${preview ? 'is-preview' : 'is-runtime'}`}>
      <div className="transport-mode">
        <button
          type="button"
          className={preview ? 'mode-btn' : 'mode-btn active'}
          onClick={actions.exitPreview}
          disabled={!preview}
        >
          运行时
        </button>
        <button
          type="button"
          className={preview ? 'mode-btn active' : 'mode-btn'}
          onClick={actions.enterPreview}
          disabled={preview}
        >
          时间预览
        </button>
      </div>

      <div className="transport-buttons">
        {preview ? (
          <>
            <button type="button" className="btn primary" onClick={actions.togglePreviewPlay}>
              {state.preview.playing ? '❚❚ 暂停预览' : '▶ 播放预览'}
            </button>
            <button type="button" className="btn" onClick={actions.step}>
              ⏭ 预览步进
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" onClick={actions.toggleRun}>
              {state.running ? '❚❚ 暂停' : '▶ 运行'}
            </button>
            <button type="button" className="btn" onClick={actions.step} disabled={state.running}>
              ⏭ 单步 16ms
            </button>
          </>
        )}
        <button type="button" className="btn muted" onClick={actions.reset}>
          ↺ 重置
        </button>
      </div>

      <div className="transport-speed">
        <span className="label">慢放</span>
        {TIME_SCALES.map((scale) => (
          <button
            type="button"
            key={scale}
            className={`chip ${state.timeScale === scale ? 'active' : ''}`}
            onClick={() => actions.setTimeScale(scale)}
          >
            {scale === 1 ? '1×' : `${scale}×`}
          </button>
        ))}
      </div>

      <div className="transport-note">
        {preview
          ? '预览只播放动作与事件位置, 不消费触发、不开启攻击窗口、不写日志'
          : state.running
            ? `运行中 · ${state.timeScale}× · 固定 16ms 更新周期`
            : '已暂停 · 可单步; 单步即一个完整更新周期'}
      </div>
    </div>
  );
}
