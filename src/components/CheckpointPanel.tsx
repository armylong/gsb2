import { useMemo } from 'react';
import { buildSnapshot } from '../lib/engine';
import { clock } from '../lib/format';
import type { CaptionEvent, Checkpoint, ReplaySnapshot } from '../lib/types';
import { CheckIcon, FlagIcon, XIcon } from './Icons';

interface CheckpointPanelProps {
  checkpoints: Checkpoint[];
  events: readonly CaptionEvent[];
  snapshot: ReplaySnapshot;
  onJump: (checkpoint: Checkpoint) => void;
}

export function CheckpointPanel({ checkpoints, events, snapshot, onJump }: CheckpointPanelProps) {
  // 每个核对点的结论只取决于事件本身，与当前播放位置无关，算一次即可。
  const results = useMemo(
    () => checkpoints.map((checkpoint) => checkpoint.verify(buildSnapshot(events, checkpoint.at, checkpoint.delay ?? 0))),
    [checkpoints, events],
  );

  if (checkpoints.length === 0) {
    return (
      <section className="checkpoints" aria-label="核对点">
        <header className="panel-head">
          <h2 className="section-title">核对点</h2>
          <p className="panel-sub">自定义导入没有预置核对点。</p>
        </header>
      </section>
    );
  }

  return (
    <section className="checkpoints" aria-label="核对点">
      <header className="panel-head">
        <div>
          <h2 className="section-title">核对点</h2>
          <p className="panel-sub">逐条跳到关键时刻，自动评估画面、状态与导出边界。</p>
        </div>
      </header>
      <ol className="checkpoint-list">
        {checkpoints.map((checkpoint, index) => {
          const pass = results[index];
          const here =
            Math.abs(snapshot.time - checkpoint.at) < 1e-9 &&
            Math.abs(snapshot.delay - (checkpoint.delay ?? 0)) < 1e-9;
          return (
            <li key={checkpoint.id}>
              <button
                type="button"
                className={`checkpoint ${pass ? 'is-pass' : 'is-fail'} ${here ? 'is-here' : ''}`}
                onClick={() => onJump(checkpoint)}
              >
                <span className="checkpoint__index">
                  {here ? <FlagIcon size={15} /> : String(index + 1).padStart(2, '0')}
                </span>
                <span className="checkpoint__body">
                  <span className="checkpoint__title">
                    {checkpoint.title}
                    {(checkpoint.delay ?? 0) > 0 && (
                      <em className="checkpoint__delay">延迟 {checkpoint.delay}s</em>
                    )}
                  </span>
                  <span className="checkpoint__detail">{checkpoint.detail}</span>
                  <span className="checkpoint__at">跳到 {clock(checkpoint.at, 2)}</span>
                </span>
                <span className={`checkpoint__verdict ${pass ? 'is-pass' : 'is-fail'}`}>
                  {pass ? <CheckIcon size={15} /> : <XIcon size={15} />}
                  {pass ? '通过' : '未通过'}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
