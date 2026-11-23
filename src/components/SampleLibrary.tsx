import { useRef } from 'react';
import { Mapping, Sample, dbToGain } from '../model/types';
import { addSample, removeSample, updateSample } from '../state/edits';
import { engine } from '../state/useEngine';
import { BUILTIN_SYNTHS } from '../audio/synth';

interface Props {
  mapping: Mapping;
  onChange: (m: Mapping) => void;
  sampleStates: Record<string, { status: string; reason?: string }>;
}

/** 素材库：内置合成音色 + 本地 WAV 上传；每行显示就绪状态与原因 */
export function SampleLibrary({ mapping, onChange, sampleStates }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const onFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return;
    let next = mapping;
    for (const file of Array.from(files)) {
      const sample = await engine.importUpload(file);
      next = addSample(next, sample);
    }
    onChange(next);
  };

  const setGain = (s: Sample, gainDb: number): void => onChange(updateSample(mapping, s.id, { gainDb }));

  return (
    <div className="panel">
      <h2>素材库（内置合成 / 本地 WAV）</h2>

      <div className="row wrap" style={{ marginBottom: 8 }}>
        <button onClick={() => fileRef.current?.click()}>上传 WAV…</button>
        <input
          ref={fileRef}
          type="file"
          accept=".wav,audio/wav,audio/x-wav,audio/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <span className="muted">上传后写入 IndexedDB，保存映射、重开浏览器仍可继续检查</span>
      </div>

      {mapping.samples.map((s) => {
        const st = sampleStates[s.id] ?? { status: 'idle' };
        const builtin = s.source.kind === 'builtin';
        const spec = builtin ? BUILTIN_SYNTHS.find((x) => x.id === (s.source as { synthId: string }).synthId) : undefined;
        const used = mapping.zones.some((z) => z.variants.some((v) => v.sampleId === s.id));
        return (
          <div className="sample-row" key={s.id}>
            <div className="name">
              <div>{s.name}</div>
              <small>
                {builtin ? `内置合成 · 峰值 ${spec?.peakDb}dBFS` : `本地文件 · ${(s.source as { fileName: string }).fileName}`} · 增益
                <input
                  type="number"
                  step={1}
                  value={s.gainDb}
                  style={{ width: 64, display: 'inline-block', margin: '0 4px' }}
                  onChange={(e) => setGain(s, Number(e.target.value))}
                  aria-label={`${s.name} 增益 dB`}
                />
                dB（×{dbToGain(s.gainDb).toFixed(2)}）
              </small>
              {st.reason && <small title={st.reason}>↳ {st.reason}</small>}
            </div>
            <span className={`badge ${st.status}`}>{st.status}</span>
            <button className="tiny" onClick={() => void engine.previewSample(s)} title="独奏试听该素材">
              听
            </button>
            <button
              className="tiny danger"
              disabled={used}
              title={used ? '仍有区域变体引用，先移除变体' : '删除素材'}
              onClick={() => onChange(removeSample(mapping, s.id))}
            >
              删
            </button>
          </div>
        );
      })}
    </div>
  );
}
