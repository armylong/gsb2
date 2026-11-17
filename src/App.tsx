import { useRef, useState } from 'react';
import { parseCube, type Lut3D } from './lut/cubeParser';
import { applyLutToImage, applyLutToPixel, type ColorSpaceMode, type Interpolation } from './lut/applyLut';
import { CompareView } from './components/CompareView';
import type { ImageState } from './types';

const SAMPLE_IMAGES = [
  { file: 'gradient.png', label: '渐变图' },
  { file: 'color-blocks.png', label: '色块图' },
  { file: 'transparent-edge.png', label: '透明边沿图' },
];

const SAMPLE_LUTS = [
  { file: 'identity.cube', label: '恒等表' },
  { file: 'swap-rb.cube', label: '红蓝交换表' },
  { file: 'warm-range.cube', label: '暖调表(非默认范围)' },
  { file: 'invalid-1d.cube', label: '一维表(应被拒绝)' },
];

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export default function App() {
  const [image, setImage] = useState<ImageState | null>(null);
  const [lut, setLut] = useState<Lut3D | null>(null);
  const [lutError, setLutError] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [interpolation, setInterpolation] = useState<Interpolation>('trilinear');
  const [mode, setMode] = useState<ColorSpaceMode>('srgb');
  const [strength, setStrength] = useState(1);
  const [pixel, setPixel] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 载入令牌:每次新选择都递增,异步完成时若令牌已过期则丢弃结果,
  // 保证旧图片/旧色表加载完成不会覆盖后来选择的内容。
  const imgToken = useRef(0);
  const lutToken = useRef(0);

  async function loadImageFile(file: Blob, name: string) {
    const token = ++imgToken.current;
    setBusy(true);
    setImgError(null);
    try {
      const res = await fetch('/api/decode', { method: 'POST', body: file });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `解码失败(${res.status})`);
      const bin = Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0));
      if (token !== imgToken.current) return; // 已有更新的选择,丢弃
      setImage({ data: new Uint8ClampedArray(bin.buffer), width: json.width, height: json.height, name });
      setPixel(null);
    } catch (e) {
      if (token === imgToken.current) setImgError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === imgToken.current) setBusy(false);
    }
  }

  async function loadLutFile(file: Blob) {
    const token = ++lutToken.current;
    try {
      const text = await file.text();
      const parsed = parseCube(text); // 解析失败会抛出,绝不用部分数据
      if (token !== lutToken.current) return;
      setLut(parsed);
      setLutError(null);
    } catch (e) {
      if (token !== lutToken.current) return;
      setLut(null);
      setLutError(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadSample(file: string, kind: 'image' | 'lut') {
    try {
      const res = await fetch(`/samples/${file}`);
      if (!res.ok) throw new Error(`示例素材 ${file} 不存在,请运行 npm run generate:samples 重新生成`);
      const blob = await res.blob();
      if (kind === 'image') await loadImageFile(blob, file);
      else await loadLutFile(blob);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === 'image') setImgError(msg);
      else setLutError(msg);
    }
  }

  async function exportPng() {
    if (!image) return;
    setExporting(true);
    try {
      // 导出走 CPU 参考实现,作用于完整分辨率的原始像素,与预览缩放无关
      const out = applyLutToImage(image.data, image.width, image.height, lut, {
        interpolation,
        mode,
        strength,
      });
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < out.length; i += chunk) {
        bin += String.fromCharCode(...out.subarray(i, i + chunk));
      }
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: image.width, height: image.height, data: btoa(bin) }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `导出失败(${res.status})`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = image.name.replace(/\.[^.]+$/, '') + '-graded.png';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setImgError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  // 像素检查器:原始值直接读取,处理后值用与导出相同的 CPU 参考实现计算
  let pixelInfo: { orig: number[]; proc: number[] } | null = null;
  if (image && pixel) {
    const o = (pixel.y * image.width + pixel.x) * 4;
    const orig = [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
    let proc = orig;
    if (lut && strength > 0) {
      const [r, g, b] = applyLutToPixel(orig[0] / 255, orig[1] / 255, orig[2] / 255, lut, {
        interpolation,
        mode,
        strength,
      });
      proc = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), orig[3]];
    }
    pixelInfo = { orig, proc };
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>LUT 调色对比</h1>

        <section>
          <h2>图片(PNG / JPEG,按 sRGB 解释)</h2>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadImageFile(f, f.name);
              e.target.value = '';
            }}
          />
          <div className="sample-row">
            {SAMPLE_IMAGES.map((s) => (
              <button key={s.file} onClick={() => void loadSample(s.file, 'image')}>
                {s.label}
              </button>
            ))}
          </div>
          {image && (
            <div className="info">
              {image.name} · {image.width}×{image.height}
            </div>
          )}
          {busy && <div className="info">解码中…</div>}
          {imgError && <div className="error">{imgError}</div>}
        </section>

        <section>
          <h2>三维色表(.cube)</h2>
          <input
            type="file"
            accept=".cube"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadLutFile(f);
              e.target.value = '';
            }}
          />
          <div className="sample-row">
            {SAMPLE_LUTS.map((s) => (
              <button key={s.file} onClick={() => void loadSample(s.file, 'lut')}>
                {s.label}
              </button>
            ))}
          </div>
          {lut && (
            <div className="info">
              <div>名称:{lut.name}</div>
              <div>
                网格:{lut.size}³(共 {lut.size ** 3} 条)
              </div>
              <div>
                输入范围:[{lut.domainMin.map((v) => v.toFixed(3)).join(', ')}] ~ [
                {lut.domainMax.map((v) => v.toFixed(3)).join(', ')}]
              </div>
              <button onClick={() => setLut(null)}>清除色表</button>
            </div>
          )}
          {lutError && <div className="error">色表被拒绝:{lutError}</div>}
        </section>

        <section>
          <h2>参数</h2>
          <label className="row">
            插值方式
            <select value={interpolation} onChange={(e) => setInterpolation(e.target.value as Interpolation)}>
              <option value="trilinear">三线性插值</option>
              <option value="nearest">最近点(对照)</option>
            </select>
          </label>
          <label className="row">
            工作空间
            <select value={mode} onChange={(e) => setMode(e.target.value as ColorSpaceMode)}>
              <option value="srgb">sRGB 编码值</option>
              <option value="linear">线性光值</option>
            </select>
          </label>
          <label className="row">
            强度 {strength.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
            />
          </label>
        </section>

        <section>
          <button className="export" disabled={!image || exporting} onClick={() => void exportPng()}>
            {exporting ? '导出中…' : '导出全分辨率 PNG'}
          </button>
        </section>

        <section className="rules">
          <h2>固定处理规则</h2>
          <ul>
            <li>图片解码后一律按 sRGB 解释(内嵌 ICC 会转换到 sRGB),8bit/通道。</li>
            <li>仅支持三维色表;一维表、条目不足、范围不合法一律拒绝。</li>
            <li>色表输入超出 DOMAIN / LUT_3D_INPUT_RANGE 范围时按边界截断(clamp)。</li>
            <li>结果超出 [0,1] 时截断到 [0,1]。</li>
            <li>强度混合在选定工作空间内进行:0 = 原图,1 = 完整色表。</li>
            <li>透明通道不参与色表运算,原样保留;不做预乘,透明边沿无黑边。</li>
            <li>导出使用与预览相同语义的 CPU 参考实现,全分辨率,与预览缩放无关。</li>
          </ul>
        </section>
      </aside>

      <main className="main">
        <div className="status-bar">
          色表:{lut ? `${lut.name}(${lut.size}³)` : '无'} · 插值:
          {interpolation === 'trilinear' ? '三线性' : '最近点'} · 强度:{strength.toFixed(2)} · 空间:
          {mode === 'srgb' ? 'sRGB 编码值' : '线性光值'}
        </div>
        <CompareView
          image={image}
          lut={lut}
          interpolation={interpolation}
          mode={mode}
          strength={strength}
          onPick={(x, y) => setPixel({ x, y })}
        />
        <div className="pixel-panel">
          {pixelInfo && pixel ? (
            <table>
              <thead>
                <tr>
                  <th>像素 ({pixel.x}, {pixel.y})</th>
                  <th>R</th>
                  <th>G</th>
                  <th>B</th>
                  <th>A</th>
                  <th>Hex</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>原图</td>
                  <td>{pixelInfo.orig[0]}</td>
                  <td>{pixelInfo.orig[1]}</td>
                  <td>{pixelInfo.orig[2]}</td>
                  <td>{pixelInfo.orig[3]}</td>
                  <td>{toHex(pixelInfo.orig[0], pixelInfo.orig[1], pixelInfo.orig[2])}</td>
                </tr>
                <tr>
                  <td>处理后</td>
                  <td>{pixelInfo.proc[0]}</td>
                  <td>{pixelInfo.proc[1]}</td>
                  <td>{pixelInfo.proc[2]}</td>
                  <td>{pixelInfo.proc[3]}</td>
                  <td>{toHex(pixelInfo.proc[0], pixelInfo.proc[1], pixelInfo.proc[2])}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <span className="dim">在画面上单击可查看指定像素的原始值与处理后数值</span>
          )}
        </div>
      </main>
    </div>
  );
}
