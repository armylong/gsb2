import { useMemo, useState } from 'react';
import { clock } from '../lib/format';
import { buildWebVtt, cueBoundaryIssues } from '../lib/webvtt';
import { copyText, downloadText, timestampSlug } from '../lib/download';
import type { ReplaySnapshot } from '../lib/types';
import { CopyIcon, DownloadIcon, FileTextIcon, PlusIcon } from './Icons';

interface ExportPanelProps {
  snapshot: ReplaySnapshot;
  scenarioName: string;
}

export function ExportPanel({ snapshot, scenarioName }: ExportPanelProps) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [showRaw, setShowRaw] = useState(false);

  const build = useMemo(() => buildWebVtt(snapshot.confirmed), [snapshot.confirmed]);
  const issues = useMemo(() => cueBoundaryIssues(snapshot.confirmed), [snapshot.confirmed]);

  const handleCopy = async () => {
    const ok = await copyText(build.vtt);
    setCopied(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopied('idle'), 1800);
  };

  const pendingCaptions = snapshot.captions.filter((caption) => !caption.final);

  return (
    <section className="export" aria-label="导出">
      <header className="panel-head">
        <div>
          <h2 className="section-title">导出 WebVTT</h2>
          <p className="panel-sub">
            只导出截至 {clock(snapshot.time, 2)} 已确认的字幕；同一条字幕只形成一个 cue。
          </p>
        </div>
        <span className="count-pill count-pill--strong">{build.exported.length} 条 cue</span>
      </header>

      <div className="export__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() =>
            downloadText(
              `${scenarioName}-${timestampSlug(snapshot.time)}.vtt`,
              build.vtt,
              'text/vtt',
            )
          }
          disabled={build.exported.length === 0}
        >
          <DownloadIcon /> 下载 .vtt
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleCopy}
          disabled={build.exported.length === 0}
        >
          <CopyIcon /> {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制内容'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setShowRaw((value) => !value)}>
          <FileTextIcon /> {showRaw ? '收起原文' : '查看原文'}
        </button>
      </div>

      <div className="export__grid">
        <div className="export__boundaries">
          <h3 className="export__subtitle">导出边界</h3>
          {build.exported.length === 0 ? (
            <p className="export__empty">还没有已确认的字幕。</p>
          ) : (
            <ol className="cue-list">
              {build.exported.map((cue, index) => (
                <li key={cue.captionId} className="cue-item">
                  <span className="cue-item__index">{index + 1}</span>
                  <div className="cue-item__body">
                    <div className="cue-item__head">
                      <code>{cue.captionId}</code>
                      <span className="cue-item__time">
                        {clock(cue.start, 2)} → {clock(cue.end, 2)}
                      </span>
                    </div>
                    <p className="cue-item__text">{cue.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {pendingCaptions.length > 0 && (
            <p className="export__note">
              {pendingCaptions.length} 条字幕尚未确认，暂不导出：
              {pendingCaptions.map((caption) => caption.captionId).join('、')}
            </p>
          )}

          {issues.length > 0 ? (
            <ul className="export__issues">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : (
            build.exported.length > 0 && (
              <p className="export__ok">
                <PlusIcon size={13} /> 边界检查通过：无重叠、无空文本、时间递增。
              </p>
            )
          )}
        </div>

        {showRaw && (
          <pre className="export__raw" aria-label="WebVTT 原文">
            <code>{build.vtt}</code>
          </pre>
        )}
      </div>
    </section>
  );
}
