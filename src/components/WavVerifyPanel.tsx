/**
 * WavVerifyPanel —— 导出 WAV 并把读回的数据与渲染源逐包对照。
 *
 * 校验项：
 *  - 头部：采样率、声道、位深、采样数；
 *  - 包络对照：读回 PCM 取绝对值包络与渲染振幅的相关度/最大偏差；
 *  - 结尾长度：两侧 trailing silence 之差（量化门限容差内）；
 *  - 起始对齐：第一个可闻采样位置。
 */
import { useState } from 'react';
import type { RenderResult } from '../audio/OfflineRenderer';
import { decodeWav, trailingSilence } from '../audio/wav';

interface Check {
  ok: boolean;
  label: string;
  detail: string;
}

interface Props {
  render: RenderResult;
  wavBuffer: ArrayBuffer | null;
  onExport: () => void;
}

/** 对读回 PCM 取绝对值后按块取最大，得到可与振幅数组对照的粗包络。 */
function blockEnvelope(pcm: Float32Array, blocks: number): Float32Array {
  const out = new Float32Array(blocks);
  const blockSize = Math.max(1, Math.floor(pcm.length / blocks));
  for (let b = 0; b < blocks; b++) {
    let peak = 0;
    const start = b * blockSize;
    const end = Math.min(pcm.length, start + blockSize);
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    out[b] = peak;
  }
  return out;
}

function pearson(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

function firstAudible(pcm: Float32Array, floor: number): number {
  for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > floor) return i;
  return -1;
}

export function WavVerifyPanel({ render, wavBuffer, onExport }: Props) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [fileName, setFileName] = useState<string>('');

  const runChecks = (buffer: ArrayBuffer, name: string) => {
    const decoded = decodeWav(buffer);
    const result: Check[] = [];

    result.push({
      ok: decoded.sampleRate === render.sampleRate,
      label: '采样率',
      detail: `读回 ${decoded.sampleRate} Hz / 渲染 ${render.sampleRate} Hz`,
    });
    result.push({
      ok: decoded.channels === 1 && decoded.bitsPerSample === 16,
      label: '格式',
      detail: `${decoded.channels} 声道, ${decoded.bitsPerSample}-bit PCM`,
    });
    result.push({
      ok: Math.abs(decoded.pcm.length - render.pcm.length) <= 1,
      label: '采样数',
      detail: `读回 ${decoded.pcm.length} / 渲染 ${render.pcm.length}`,
    });

    // 包络形状对照（块峰值 vs 渲染振幅，同样按块取峰）
    const blocks = 256;
    const decodedEnv = blockEnvelope(decoded.pcm, blocks);
    const sourceEnv = blockEnvelope(render.pcm, blocks);
    const corr = pearson(decodedEnv, sourceEnv);
    result.push({
      ok: corr > 0.995,
      label: '包络形状相关度',
      detail: `Pearson r = ${corr.toFixed(5)}（阈值 0.995）`,
    });

    // 最大逐采样偏差（16-bit 量化应在 ~1/32768 量级）
    let maxErr = 0;
    const n = Math.min(decoded.pcm.length, render.pcm.length);
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(decoded.pcm[i] - render.pcm[i]));
    result.push({
      ok: maxErr < 1.5 / 32768,
      label: '逐采样最大偏差',
      detail: `${maxErr.toExponential(2)}（16-bit 台阶 ${(1 / 32768).toExponential(2)}）`,
    });

    // 结尾静音长度
    const silDecoded = trailingSilence(decoded.pcm);
    const silSource = trailingSilence(render.pcm);
    const silDiff = Math.abs(silDecoded - silSource) / render.sampleRate;
    result.push({
      ok: silDiff <= 0.003,
      label: '结尾静音长度差',
      detail: `${(silDiff * 1000).toFixed(2)} ms（读回 ${(silDecoded / render.sampleRate).toFixed(3)}s / 源 ${(silSource / render.sampleRate).toFixed(3)}s）`,
    });

    // 起始可闻位置
    const firstD = firstAudible(decoded.pcm, 1e-4);
    const firstS = firstAudible(render.pcm, 1e-4);
    result.push({
      ok: firstD >= 0 && Math.abs(firstD - firstS) <= 1,
      label: '起始对齐',
      detail: `首个可闻采样 读回 #${firstD} / 源 #${firstS}`,
    });

    setChecks(result);
    setFileName(name);
  };

  const onImport = async (file: File) => {
    const buf = await file.arrayBuffer();
    runChecks(buf, file.name);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="primary" onClick={onExport}>
          导出 WAV
        </button>
        <button
          type="button"
          onClick={() => document.getElementById('wav-file-input')?.click()}
        >
          读回 WAV 对照
        </button>
        <input
          id="wav-file-input"
          type="file"
          accept=".wav,audio/wav,audio/x-wav"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = '';
          }}
        />
        {wavBuffer && (
          <button className="tiny" onClick={() => runChecks(wavBuffer, '当前导出的 WAV')}>
            直接校验刚导出的文件
          </button>
        )}
      </div>

      {checks.length > 0 && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            对照文件：{fileName}
          </p>
          <div className="verify-list">
            {checks.map((c) => (
              <div key={c.label} className={`verify-item ${c.ok ? 'ok' : 'bad'}`}>
                <span className="mark">{c.ok ? '✓' : '✗'}</span>
                <span>{c.label}</span>
                <span className="detail">{c.detail}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
