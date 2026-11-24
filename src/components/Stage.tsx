import type { CaptionState, ScreenCaption } from '../lib/types';
import { clock } from '../lib/format';
import { ClockIcon } from './Icons';

interface StageProps {
  screen: ScreenCaption[];
  captions: CaptionState[];
  presentationTime: number;
  replayTime: number;
  delay: number;
}

function nextUpcoming(captions: CaptionState[], presentationTime: number): CaptionState | null {
  const upcoming = captions
    .filter(
      (caption) =>
        caption.accepted !== null &&
        caption.accepted.mediaStart > presentationTime &&
        caption.window !== 'onscreen',
    )
    .sort((a, b) => a.accepted!.mediaStart - b.accepted!.mediaStart);
  return upcoming[0] ?? null;
}

export function Stage({ screen, captions, presentationTime, replayTime, delay }: StageProps) {
  const upcoming = nextUpcoming(captions, presentationTime);
  const pendingOnScreen = screen.length === 0;

  return (
    <section className="stage" aria-label="当前画面">
      <div className="stage__frame">
        <div className="stage__backdrop" aria-hidden="true" />
        <div className="stage__vignette" aria-hidden="true" />

        <div className="stage__hud">
          <span className="stage__hud-item">
            <ClockIcon size={14} />
            画面 {clock(presentationTime, 2)}
          </span>
          <span className="stage__hud-sep" aria-hidden="true" />
          <span className="stage__hud-item stage__hud-item--muted">
            接收 {clock(replayTime, 2)}
          </span>
          {delay > 0 && (
            <span className="stage__hud-badge" title="画面比接收时钟落后">
              缓冲 {delay.toFixed(1)}s
            </span>
          )}
        </div>

        <div className="stage__bottom">
          {screen.length > 0 ? (
            <div className="stage__captions" aria-live="polite">
              {screen.map((caption) => (
                <div key={caption.captionId} className="stage__caption">
                  <span className="stage__caption-text">{caption.text}</span>
                  <span className="stage__caption-meta">
                    {caption.captionId} · 第 {caption.seq} 版
                    {caption.final ? ' · 已确认' : ' · 待确认'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="stage__empty">
              <span className="stage__empty-mark" aria-hidden="true" />
              <span>{pendingOnScreen ? '此刻画面没有字幕' : '此区间无字幕'}</span>
            </div>
          )}

          {upcoming && (
            <div className="stage__next">
              下一句 {clock(upcoming.accepted!.mediaStart, 1)} · {upcoming.captionId}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
