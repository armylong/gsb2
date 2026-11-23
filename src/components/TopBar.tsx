import { useEffect, useState } from 'react';
import { Mapping } from '../model/types';
import { engine } from '../state/useEngine';

interface Props {
  mapping: Mapping;
  onMappingChange: (m: Mapping) => void;
  initialized: boolean;
  saving: boolean;
  lastSavedAt: number | undefined;
  onSave: () => void;
  onReload: () => void;
}

export function TopBar({ mapping, onMappingChange, initialized, saving, lastSavedAt, onSave, onReload }: Props) {
  const [level, setLevel] = useState(0);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!initialized) return;
    const id = setInterval(() => setLevel(engine.readLevel()), 60);
    return () => clearInterval(id);
  }, [initialized]);

  const captureKey = (e: React.KeyboardEvent): void => {
    e.preventDefault();
    if (e.code === 'Escape') {
      setCapturing(false);
      return;
    }
    onMappingChange({ ...mapping, triggerCode: e.code });
    setCapturing(false);
  };

  return (
    <div className="topbar">
      <h1>脚步采样映射试播器</h1>
      {!initialized ? (
        <button className="primary" onClick={() => void engine.init()}>
          启用音频（浏览器要求先点一下）
        </button>
      ) : (
        <span className="badge ready">AudioContext 已启用</span>
      )}

      <div className="meter" title="主输出 RMS 电平">
        <div style={{ width: `${Math.min(100, level * 180)}%` }} />
      </div>

      <span className="spacer" />

      <label className="row" style={{ gap: 6 }}>
        <span className="muted">触发键</span>
        <button onClick={() => setCapturing(true)} onKeyDown={capturing ? captureKey : undefined}>
          {capturing ? '按任意键…（Esc 取消）' : mapping.triggerCode === 'Space' ? 'Space 空格' : mapping.triggerCode}
        </button>
      </label>

      <label className="row" style={{ gap: 6 }}>
        <span className="muted">最大同时播放</span>
        <input
          type="number"
          min={1}
          max={16}
          style={{ width: 64 }}
          value={mapping.maxVoices}
          onChange={(e) => onMappingChange({ ...mapping, maxVoices: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>

      <button onClick={onSave} disabled={saving}>
        {saving ? '保存中…' : '保存映射'}
      </button>
      <button onClick={onReload} title="从 IndexedDB 重新载入（模拟重开浏览器后恢复）">
        重开恢复
      </button>
      <span className="save-state">
        {lastSavedAt ? `上次保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未保存'}
      </span>
    </div>
  );
}
