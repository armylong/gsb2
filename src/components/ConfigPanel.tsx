import { useState } from 'react';
import type { StudioSnapshot } from '../studio/store';

interface ConfigPanelProps {
  state: StudioSnapshot;
  actions: {
    applyDraft: () => void;
    revertDraft: () => void;
    loadDemo: () => void;
    save: () => void;
    load: () => void;
    importText: (text: string) => boolean;
    draftText: () => string;
    dismissNotice: () => void;
  };
}

export function ConfigPanel({ state, actions }: ConfigPanelProps) {
  const [text, setText] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(true);
  const hasErrors = state.draftErrors.length > 0;

  const draftText = text ?? JSON.stringify(state.draft, null, 2);

  return (
    <section className="config-panel">
      <header className="panel-header">
        <h2>配置</h2>
        <span className={`tag ${state.dirty ? 'warn' : 'ok'}`}>
          {state.dirty ? '草稿未应用' : '已应用'}
        </span>
        <button
          type="button"
          className={`btn primary ${hasErrors ? 'blocked' : ''}`}
          onClick={() => actions.applyDraft()}
          disabled={!state.dirty}
          title={hasErrors ? '草稿有校验错误, 应用会被拒绝' : '应用草稿并重跑'}
        >
          应用
        </button>
        <button
          type="button"
          className="btn muted"
          onClick={() => {
            setText(null);
            actions.revertDraft();
          }}
          disabled={!state.dirty}
        >
          撤销修改
        </button>
        <button type="button" className="btn" onClick={actions.save}>
          保存
        </button>
        <button type="button" className="btn" onClick={actions.load}>
          载入
        </button>
        <button
          type="button"
          className="btn muted"
          onClick={() => {
            setText(null);
            actions.loadDemo();
          }}
        >
          恢复内置示例
        </button>
      </header>

      {state.draftErrors.length > 0 ? (
        <div className="errors">
          <button type="button" className="errors-head" onClick={() => setShowErrors(!showErrors)}>
            校验错误 {state.draftErrors.length} 条 {showErrors ? '▾' : '▸'}
          </button>
          {showErrors ? (
            <ul>
              {state.draftErrors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state.draftWarnings.length > 0 ? (
        <div className="warnings">
          <ul>
            {state.draftWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="json-editor">
        <summary>JSON 文本 (载入前会整体校验)</summary>
        <textarea
          value={draftText}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          rows={16}
        />
        <div className="json-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (actions.importText(draftText)) setText(null);
            }}
          >
            校验并载入草稿
          </button>
          <button type="button" className="btn muted" onClick={() => setText(null)}>
            放弃文本修改
          </button>
        </div>
      </details>

      {state.notice ? (
        <div className={`notice ${state.notice.kind}`}>
          <div className="notice-text">
            {state.notice.text}
            <button
              type="button"
              className="notice-close"
              onClick={actions.dismissNotice}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
          {state.notice.details ? (
            <ul>
              {state.notice.details.slice(0, 8).map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
