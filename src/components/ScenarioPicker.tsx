import { useRef, useState } from 'react';
import { parseCaptionEventsText } from '../lib/validate';
import type { CaptionEvent, Scenario } from '../lib/types';
import { AlertIcon, UploadIcon } from './Icons';

export interface LoadedSource {
  id: string;
  name: string;
  description: string;
  events: CaptionEvent[];
  checkpoints: Scenario['checkpoints'];
  builtIn: boolean;
}

interface ScenarioPickerProps {
  scenarios: Scenario[];
  activeId: string;
  onSelect: (id: string) => void;
  onImport: (source: LoadedSource) => void;
}

const SAMPLE_JSON = `[
  { "id": "e1", "captionId": "cap-1", "seq": 1, "kind": "revision",
    "text": "先说一句。", "mediaStart": 1, "mediaEnd": 4, "arrival": 0.5 },
  { "id": "e2", "captionId": "cap-1", "seq": 2, "kind": "final",
    "text": "先说一句，再补一句。", "mediaStart": 1, "mediaEnd": 4, "arrival": 2 }
]`;

export function ScenarioPicker({ scenarios, activeId, onSelect, onImport }: ScenarioPickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = () => {
    const result = parseCaptionEventsText(text);
    if (!result.ok) {
      setErrors(result.errors);
      setWarnings(result.warnings);
      return;
    }
    setErrors([]);
    setWarnings(result.warnings);
    onImport({
      id: `import-${Date.now()}`,
      name: result.name,
      description: '从 JSON 导入的事件。',
      events: result.events,
      checkpoints: [],
      builtIn: false,
    });
    setOpen(false);
    setText('');
  };

  const loadFile = async (file: File) => {
    setFileName(file.name);
    try {
      const content = await file.text();
      setText(content);
      const result = parseCaptionEventsText(content);
      if (result.ok) {
        setErrors([]);
        setWarnings(result.warnings);
      } else {
        setErrors(result.errors);
        setWarnings(result.warnings);
      }
    } catch (error) {
      setErrors([`读取文件失败：${error instanceof Error ? error.message : String(error)}`]);
      setWarnings([]);
    }
  };

  return (
    <section className="picker" aria-label="样例与导入">
      <div className="picker__tabs" role="group" aria-label="选择回放来源">
        {scenarios.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            aria-pressed={activeId === scenario.id}
            className={`scenario-tab ${activeId === scenario.id ? 'is-active' : ''}`}
            onClick={() => onSelect(scenario.id)}
          >
            <span className="scenario-tab__kicker">{scenario.kicker}</span>
            <span className="scenario-tab__name">{scenario.name}</span>
            <span className="scenario-tab__meta">
              {scenario.events.length} 次投递 ·{' '}
              {new Set(scenario.events.map((event) => event.captionId)).size} 条字幕
            </span>
          </button>
        ))}
        <button
          type="button"
          className={`scenario-tab scenario-tab--import ${open ? 'is-active' : ''}`}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-pressed={open}
        >
          <span className="scenario-tab__kicker">自定义</span>
          <span className="scenario-tab__name">
            <UploadIcon size={15} /> 导入事件
          </span>
          <span className="scenario-tab__meta">粘贴 JSON</span>
        </button>
      </div>

      {open && (
        <div className="picker__panel">
          <label className="picker__field">
            <span className="field__label">事件 JSON</span>
            <textarea
              className="textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={SAMPLE_JSON}
              rows={8}
              spellCheck={false}
            />
          </label>
          <div className="picker__actions">
            <button type="button" className="btn btn--primary" onClick={load} disabled={text.trim() === ''}>
              载入
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => fileInput.current?.click()}
            >
              选择 JSON 文件
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setText(SAMPLE_JSON);
                setFileName(null);
                setErrors([]);
                setWarnings([]);
              }}
            >
              填入示例
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
                event.target.value = '';
              }}
            />
          </div>
          {fileName && <p className="picker__file">已读取 {fileName}</p>}
          {errors.length > 0 && (
            <ul className="picker__errors">
              {errors.map((error) => (
                <li key={error}>
                  <AlertIcon size={14} /> {error}
                </li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="picker__warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="picker__hint">
            必填字段：id、captionId、seq、kind（revision/final）、text、mediaStart、mediaEnd、arrival，单位均为秒。
          </p>
        </div>
      )}
    </section>
  );
}
