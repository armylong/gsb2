import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnimationSpec,
  AtlasFrame,
  BuildResult,
  PackIssue,
  PackSettings,
  SourceFrameInfo,
} from '../shared/types';
import { DEFAULT_ANIMATION, DEFAULT_SETTINGS } from '../shared/types';
import type { AtlasManifest } from '../shared/types';
import { useBuild, useFrames } from './hooks';
import * as api from './lib/api';
import {
  loadExportFiles,
  loadExportZip,
  parseAnimationJsonText,
  type LoadedExport,
} from './lib/bundleLoader';
import { AnimationPlayer, AnimationStrip } from './components/AnimationPlayer';
import { AtlasPageView, FrameCompare, FrameRow, VerificationList } from './components/panels';
import { verifyStructure } from '../shared/verify';

type Tab = 'atlas' | 'animation' | 'export';

const SETTING_FIELDS: { key: keyof PackSettings; label: string; hint: string; min: number; max: number }[] = [
  { key: 'pageWidth', label: '页面宽度上限', hint: 'px，也是最终页宽', min: 16, max: 8192 },
  { key: 'pageHeight', label: '页面高度上限', hint: 'px，也是最终页高', min: 16, max: 8192 },
  { key: 'spacing', label: '帧间距', hint: 'px，纯空白内容间距', min: 0, max: 256 },
  { key: 'margin', label: '页面边距', hint: 'px，四边留空', min: 0, max: 256 },
  { key: 'extrude', label: '边缘扩展', hint: 'px，防采样串色的复制边', min: 0, max: 16 },
];

export function App() {
  const { frames, busy: importing, notice, setNotice, addFiles, addSamples, remove } = useFrames();
  const { build, busy: packing, error: packError, run: pack } = useBuild();
  const [settings, setSettings] = useState<PackSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>('atlas');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showOutline, setShowOutline] = useState(true);
  const [animation, setAnimation] = useState<AnimationSpec>(DEFAULT_ANIMATION);
  const [exportResult, setExportResult] = useState<api.ExportResponse | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [standalone, setStandalone] = useState<LoadedExport | null>(null);
  const [standaloneError, setStandaloneError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const atlasById = useMemo(() => {
    const map = new Map<string, AtlasFrame>();
    for (const frame of build?.manifest.frames ?? []) map.set(frame.id, frame);
    return map;
  }, [build]);

  useEffect(() => {
    if (!build) return;
    if (selectedId && build.manifest.frames.some((frame) => frame.id === selectedId)) return;
    setSelectedId(build.manifest.frames[0]?.id ?? null);
  }, [build, selectedId]);

  useEffect(() => {
    setPageIndex(0);
    setExportResult(null);
    // A new build invalidates the previous standalone preview: release the
    // object URLs created for a ZIP/file load so they are not leaked.
    setStandalone((current) => {
      current?.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      return null;
    });
  }, [build?.buildId]);

  const selectedFrame = useMemo(
    () => frames.find((frame) => frame.id === selectedId) ?? null,
    [frames, selectedId],
  );
  const selectedAtlas = selectedId ? atlasById.get(selectedId) ?? null : null;

  const runPack = useCallback(async () => {
    const result = await pack(settings);
    if (result) {
      setTab('atlas');
      setNotice(
        result.issues.length > 0
          ? { kind: 'error', text: `打包完成，但有 ${result.issues.length} 条问题需要处理` }
          : { kind: 'success', text: `打包完成：${result.manifest.pages.length} 页，${result.manifest.summary.packed} 帧已放置` },
      );
    }
    return result;
  }, [pack, setNotice, settings]);

  const runExport = async () => {
    if (!build) {
      setExportError('请先打包');
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const result = await api.exportBuild(build.buildId, animation);
      setExportResult(result);
      setNotice({
        kind: result.verification.ok ? 'success' : 'error',
        text: result.verification.ok
          ? `导出完成：${result.files.length} 个文件，逐帧像素校验通过`
          : '导出完成，但自动校验未通过，请查看报告',
      });
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  };

  const loadStandalone = async (exportId: string) => {
    setStandaloneError(null);
    const previous = standalone;
    try {
      const loaded = await loadStandalonePreview(exportId);
      if (previous) previous.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      setStandalone(loaded);
    } catch (caught) {
      setStandaloneError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const loadFromFiles = async (loader: () => Promise<LoadedExport>, source: 'zip' | 'files') => {
    setStandaloneError(null);
    const previous = standalone;
    try {
      const loaded = await loader();
      if (previous) previous.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      setStandalone({ ...loaded, source });
    } catch (caught) {
      setStandaloneError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const animationIds = useMemo(() => animation.frames.map((frame) => frame.id), [animation.frames]);
  const toggleAnimationFrame = (frame: SourceFrameInfo, atlas: AtlasFrame | undefined) => {
    if (!atlas) return;
    setAnimation((current) => {
      const existing = current.frames.findIndex((entry) => entry.id === frame.id);
      if (existing >= 0) {
        return { ...current, frames: current.frames.filter((entry) => entry.id !== frame.id) };
      }
      return { ...current, frames: [...current.frames, { id: frame.id, durationMs: 120 }] };
    });
  };

  const moveAnimationFrame = (index: number, delta: number) => {
    setAnimation((current) => {
      const next = [...current.frames];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, frames: next };
    });
  };

  const pageUrlFor = useCallback(
    (frame: AtlasFrame) => (frame.page === null || !build ? null : build.pages[frame.page]?.url ?? null),
    [build],
  );
  const standalonePageUrlFor = useCallback(
    (frame: AtlasFrame) =>
      frame.page === null || !standalone ? null : standalone.pageUrls[frame.page] ?? null,
    [standalone],
  );

  const unplacedIssues = (build?.issues ?? []).filter((issue) => issue.code === 'FRAME_TOO_LARGE');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>精灵图集工具</h1>
            <p className="sub">多页 · 透明裁边 · 顺时针旋转 · 像素级还原校验</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="mono muted">{frames.length} 张已导入</span>
          <button
            type="button"
            className="button primary"
            onClick={() => void runPack()}
            disabled={packing || frames.length === 0}
          >
            {packing ? '打包中…' : '打包'}
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          {notice.text}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <h2>导入图片</h2>
            <div className="import-actions">
              <button type="button" className="button" disabled={importing} onClick={() => fileInput.current?.click()}>
                选择 PNG（可多选）
              </button>
              <button type="button" className="button" disabled={importing} onClick={() => dirInput.current?.click()}>
                导入整个目录
              </button>
              <button type="button" className="button subtle" disabled={importing} onClick={() => void addSamples()}>
                载入示例素材
              </button>
            </div>
            <p className="hint">
              同名文件来自不同目录时会作为不同帧（标识由像素内容和相对路径共同决定）。
              全透明图片会保留并参与打包，不会被丢弃。
            </p>
            <input
              ref={fileInput}
              type="file"
              accept="image/png"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) void addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <input
              ref={dirInput}
              type="file"
              // @ts-expect-error non-standard but supported in Chromium/Safari
              webkitdirectory="true"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) void addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>帧列表</h2>
              {frames.length > 0 && (
                <button
                  type="button"
                  className="link"
                  onClick={() => void remove(frames.map((frame) => frame.id))}
                >
                  清空
                </button>
              )}
            </div>
            {frames.length === 0 ? (
              <p className="muted">还没有图片。选择 PNG 或载入示例素材开始。</p>
            ) : (
              <ul className="frame-list">
                {frames.map((frame) => (
                  <FrameRow
                    key={frame.id}
                    frame={frame}
                    atlasFrame={atlasById.get(frame.id)}
                    selected={frame.id === selectedId}
                    inAnimation={animationIds.includes(frame.id)}
                    onToggleAnimation={() => toggleAnimationFrame(frame, atlasById.get(frame.id))}
                    onSelect={() => {
                      setSelectedId(frame.id);
                      const atlas = atlasById.get(frame.id);
                      if (atlas && atlas.page !== null) {
                        setPageIndex(atlas.page);
                        setTab('atlas');
                      }
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main className="main">
          <nav className="tabs">
            <button type="button" className={tab === 'atlas' ? 'active' : ''} onClick={() => setTab('atlas')}>
              图集预览与对比
            </button>
            <button type="button" className={tab === 'animation' ? 'active' : ''} onClick={() => setTab('animation')}>
              动画
            </button>
            <button type="button" className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>
              导出与独立预览
            </button>
          </nav>

          {tab !== 'export' && (
            <section className="panel settings-panel">
              <div className="panel-head">
                <h2>打包设置</h2>
                <span className="hint">所有尺寸单位为像素（px）</span>
              </div>
              <div className="settings-grid">
                {SETTING_FIELDS.map((field) => (
                  <label key={field.key}>
                    <span>{field.label}</span>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={1}
                      value={settings[field.key] as number}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          [field.key]: clamp(Number(event.target.value), field.min, field.max),
                        }))
                      }
                    />
                    <small>{field.hint}</small>
                  </label>
                ))}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.allowRotation}
                    onChange={(event) => setSettings((current) => ({ ...current, allowRotation: event.target.checked }))}
                  />
                  <span>允许旋转（顺时针 90°，仅在更省空间时使用）</span>
                </label>
              </div>
              <p className="hint">
                帧间距是帧与帧之间的纯空白；边缘扩展则是在每帧内容四周复制边缘像素，用来避免采样串色。
                两者独立计算，导出数据分别记录。
              </p>
              {packError && <p className="error">{packError}</p>}
            </section>
          )}

          {tab === 'atlas' && (
            <>
              {!build ? (
                <section className="panel empty-state">
                  <p>导入图片后点击右上角「打包」，即可查看多页图集。</p>
                  <p className="muted">
                    打包会检查页面边界、重叠、稳定标识，并从生成的 PNG 逐帧还原后与原图比对像素。
                  </p>
                </section>
              ) : (
                <>
                  <BuildIssues build={build} />
                  <section className="panel atlas-panel">
                    <div className="panel-head">
                      <h2>页面预览</h2>
                      <div className="toolbar">
                        <button
                          type="button"
                          className="button small"
                          onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
                          disabled={pageIndex === 0}
                        >
                          上一页
                        </button>
                        <select
                          value={pageIndex}
                          onChange={(event) => setPageIndex(Number(event.target.value))}
                        >
                          {build.manifest.pages.map((page) => (
                            <option key={page.index} value={page.index}>
                              第 {page.index + 1} 页 · {page.width}×{page.height} px
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="button small"
                          onClick={() =>
                            setPageIndex((index) => Math.min(build.manifest.pages.length - 1, index + 1))
                          }
                          disabled={pageIndex >= build.manifest.pages.length - 1}
                        >
                          下一页
                        </button>
                        <label className="zoom">
                          缩放
                          <input
                            type="range"
                            min={0.25}
                            max={4}
                            step={0.25}
                            value={zoom}
                            onChange={(event) => setZoom(Number(event.target.value))}
                          />
                          <span className="mono">{Math.round(zoom * 100)}%</span>
                        </label>
                        <label className="checkbox compact">
                          <input
                            type="checkbox"
                            checked={showOutline}
                            onChange={(event) => setShowOutline(event.target.checked)}
                          />
                          <span>原始画布轮廓</span>
                        </label>
                      </div>
                    </div>
                    <div className="atlas-body">
                      <AtlasPageView
                        build={build}
                        pageIndex={Math.min(pageIndex, build.manifest.pages.length - 1)}
                        zoom={zoom}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        showSourceOutline={showOutline}
                      />
                      <div className="compare-side">
                        <h3>选中帧对比</h3>
                        {selectedFrame && selectedAtlas ? (
                          <>
                            <FrameCompare frame={selectedFrame} atlasFrame={selectedAtlas} build={build} selected />
                            <p className="hint">
                              左为原图（原始画布），右为按导出数据从图集页面裁切、反向旋转并放回原始画布后的结果。
                              旋转只影响打包方向，最终呈现方向与原图一致。
                            </p>
                          </>
                        ) : (
                          <p className="muted">在页面或帧列表中选择一帧。</p>
                        )}
                      </div>
                    </div>
                    <div className="legend">
                      <span><i className="swatch content" /> 有效内容区（contentRect）</span>
                      <span><i className="swatch slot" /> 槽位含扩展边（packedRect）</span>
                      <span><i className="swatch source" /> 原始画布轮廓</span>
                      <span><i className="swatch margin" /> 页面边距</span>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>自动验证</h2>
                    <VerificationList report={build.verification} />
                  </section>
                </>
              )}
            </>
          )}

          {tab === 'animation' && (
            <section className="panel">
              <div className="panel-head">
                <h2>动画序列</h2>
                <span className="hint">按稳定标识引用帧；移除或重排图片不会改变已有帧的标识</span>
              </div>
              {animation.frames.length === 0 ? (
                <p className="muted">在左侧帧列表点击「+」把帧加入动画，然后在这里设置时长并播放。</p>
              ) : (
                <>
                  <div className="anim-controls">
                    <label>
                      动画名称
                      <input
                        type="text"
                        value={animation.name}
                        onChange={(event) => setAnimation((current) => ({ ...current, name: event.target.value }))}
                      />
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={animation.loop}
                        onChange={(event) => setAnimation((current) => ({ ...current, loop: event.target.checked }))}
                      />
                      <span>循环播放</span>
                    </label>
                    <label>
                      基准点 X（0–1）
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={animation.anchor.x}
                        onChange={(event) =>
                          setAnimation((current) => ({
                            ...current,
                            anchor: { ...current.anchor, x: clamp(Number(event.target.value), 0, 1) },
                          }))
                        }
                      />
                    </label>
                    <label>
                      基准点 Y（0–1）
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={animation.anchor.y}
                        onChange={(event) =>
                          setAnimation((current) => ({
                            ...current,
                            anchor: { ...current.anchor, y: clamp(Number(event.target.value), 0, 1) },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <ol className="anim-editor">
                    {animation.frames.map((entry, index) => {
                      const frame = atlasById.get(entry.id);
                      return (
                        <li key={`${entry.id}-${index}`}>
                          <span className="mono idx">{index + 1}</span>
                          <span className="name" title={entry.id}>
                            {frame?.name ?? entry.id}
                            <span className="mono muted"> · {entry.id}</span>
                          </span>
                          <label>
                            时长
                            <input
                              type="number"
                              min={10}
                              max={60000}
                              step={10}
                              value={entry.durationMs}
                              onChange={(event) =>
                                setAnimation((current) => ({
                                  ...current,
                                  frames: current.frames.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, durationMs: clamp(Number(event.target.value), 10, 60000) }
                                      : item,
                                  ),
                                }))
                              }
                            />
                            ms
                          </label>
                          <span className="mono muted">
                            {frame?.page !== null && frame?.page !== undefined ? `第 ${frame.page + 1} 页` : '未放置'}
                          </span>
                          <button type="button" className="button small" onClick={() => moveAnimationFrame(index, -1)} disabled={index === 0}>
                            ↑
                          </button>
                          <button
                            type="button"
                            className="button small"
                            onClick={() => moveAnimationFrame(index, 1)}
                            disabled={index === animation.frames.length - 1}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="button small"
                            onClick={() =>
                              setAnimation((current) => ({
                                ...current,
                                frames: current.frames.filter((_, itemIndex) => itemIndex !== index),
                              }))
                            }
                          >
                            移除
                          </button>
                        </li>
                      );
                    })}
                  </ol>

                  {build ? (
                    <>
                      <AnimationPlayer
                        manifest={build.manifest}
                        spec={animation}
                        pageUrlFor={pageUrlFor}
                        zoom={Math.max(1, zoom)}
                      />
                      <p className="hint">
                        播放时每帧先各自还原到原始画布，再把各帧统一基准点对齐到同一位置；
                        因此透明边界不同、分布在不同页面的帧也不会出现位置跳动。
                      </p>
                    </>
                  ) : (
                    <p className="muted">先打包，才能预览动画。</p>
                  )}
                </>
              )}
            </section>
          )}

          {tab === 'export' && (
            <section className="panel">
              <div className="panel-head">
                <h2>导出</h2>
                <button type="button" className="button primary" onClick={() => void runExport()} disabled={!build || exporting}>
                  {exporting ? '导出中…' : '导出全部页面、帧描述与动画描述'}
                </button>
              </div>
              {!build && <p className="muted">请先打包。</p>}
              {exportError && <p className="error">{exportError}</p>}
              {exportResult && (
                <>
                  <div className="export-actions">
                    <a className="button" href={api.exportZipUrl(exportResult.exportId)}>
                      下载 ZIP
                    </a>
                    <span className="mono muted">exportId {exportResult.exportId}</span>
                  </div>
                  <ul className="file-list">
                    {exportResult.files.map((file) => (
                      <li key={file}>
                        <a href={api.exportFileUrl(exportResult.exportId, file)} className="mono">
                          {file}
                        </a>
                      </li>
                    ))}
                  </ul>
                  {exportResult.warnings.length > 0 && (
                    <ul className="warnings">
                      {exportResult.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <h3>导出包自动验证</h3>
                  <VerificationList report={exportResult.verification} />
                  <div className="standalone">
                    <h3>从导出文件独立预览</h3>
                    <p className="hint">
                      仅读取导出的 atlas.json、页面 PNG 和 animation.json，不使用任何原图，
                      用于确认导出数据本身足以还原动画。下面两种方式任选其一。
                    </p>
                    <div className="standalone-load">
                      <button
                        type="button"
                        className="button"
                        onClick={() => void loadStandalone(exportResult.exportId)}
                      >
                        载入本次导出并预览
                      </button>
                      <button type="button" className="button" onClick={() => zipInput.current?.click()}>
                        打开导出的 ZIP
                      </button>
                      <button type="button" className="button" onClick={() => filesInput.current?.click()}>
                        选择已解压的文件
                      </button>
                      <input
                        ref={zipInput}
                        type="file"
                        accept=".zip,application/zip"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (!file) return;
                          void loadFromFiles(() => loadExportZip(file), 'zip');
                        }}
                      />
                      <input
                        ref={filesInput}
                        type="file"
                        accept=".json,.png,application/json,image/png"
                        multiple
                        hidden
                        onChange={(event) => {
                          const list = Array.from(event.target.files ?? []);
                          event.target.value = '';
                          if (list.length === 0) return;
                          void loadFromFiles(() => loadExportFiles(list), 'files');
                        }}
                      />
                    </div>
                    {standaloneError && <p className="error">{standaloneError}</p>}
                    {standalone && (
                      <>
                        <p className="mono muted">
                          来源：
                          {standalone.source === 'server'
                            ? '本地导出接口'
                            : standalone.source === 'zip'
                              ? 'ZIP 文件'
                              : '散装文件'}{' '}
                          · atlas.json 页面数{' '}
                          {standalone.manifest.pages.length} · animation.json 帧数{' '}
                          {standalone.animation.frames.length}
                        </p>
                        <VerificationList
                          report={{
                            ok: standalone.checks.every((check) => check.ok),
                            checks: standalone.checks,
                            framesChecked: standalone.manifest.summary.packed,
                            pagesChecked: standalone.manifest.pages.length,
                            ignoredTransparentPixels: 0,
                            warnings: [],
                          }}
                          compact
                        />
                        <AnimationPlayer
                          manifest={standalone.manifest}
                          spec={standalone.animation}
                          pageUrlFor={standalonePageUrlFor}
                          zoom={Math.max(1, zoom)}
                        />
                        <AnimationStrip manifest={standalone.manifest} spec={standalone.animation} />
                      </>
                    )}
                  </div>
                </>
              )}
              {exportResult && build && unplacedIssues.length > 0 && (
                <p className="hint">
                  注意：{unplacedIssues.length} 张图片超出页面容量，未写入页面；导出中会以 unplaced 状态明确列出，不会被静默丢弃。
                </p>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function BuildIssues({ build }: { build: BuildResult }) {
  if (build.issues.length === 0) {
    return (
      <section className="panel compact-panel ok-panel">
        <strong>打包成功</strong>
        <span>
          {build.manifest.pages.length} 页 · {build.manifest.summary.packed} 帧已放置 ·{' '}
          {build.manifest.summary.empty} 个全透明帧
        </span>
      </section>
    );
  }
  return (
    <section className="panel compact-panel bad-panel">
      <div className="panel-head">
        <strong>打包问题（{build.issues.length}）</strong>
        <span className="hint">无法容纳的大图不会被缩放或拆分</span>
      </div>
      <ul className="issue-list">
        {build.issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.frameId ?? index}-${index}`} className={issueClass(issue)}>
            <span className="mono">{issue.code}</span> {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function issueClass(issue: PackIssue): string {
  return issue.code === 'FRAME_TOO_LARGE' ? 'bad' : 'warn';
}

async function loadStandalonePreview(exportId: string): Promise<LoadedExport> {
  const base = `/api/export/${encodeURIComponent(exportId)}`;
  const manifestResponse = await fetch(`${base}/atlas.json`);
  if (!manifestResponse.ok) throw new Error(`无法读取 atlas.json (${manifestResponse.status})`);
  const manifest = (await manifestResponse.json()) as AtlasManifest;
  const animationResponse = await fetch(api.exportFileUrl(exportId, 'animation.json'));
  if (!animationResponse.ok) throw new Error(`无法读取 animation.json (${animationResponse.status})`);
  const animation = parseAnimationJsonText(await animationResponse.text());
  const pageUrls = manifest.pages.map((page) => api.exportFileUrl(exportId, `pages/${page.file}`));
  return {
    manifest,
    animation,
    pageUrls,
    checks: verifyStructure(manifest),
    objectUrls: [],
    source: 'server',
  };
}
