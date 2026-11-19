import { useEffect, useRef, useState } from 'react';
import { sourceCanvasOutline } from '../../shared/geometry';
import type { AtlasFrame, BuildResult, SourceFrameInfo, VerificationReport } from '../../shared/types';
import * as api from '../lib/api';
import { drawRGBA, imageToRGBA, loadImage, makeCanvas } from '../lib/canvas';
import { reconstructFrame } from '../../shared/reconstruct';
import { compareImages } from '../../shared/pixels';

export interface FrameRowProps {
  frame: SourceFrameInfo;
  atlasFrame: AtlasFrame | undefined;
  selected: boolean;
  onSelect: () => void;
  onToggleAnimation: () => void;
  inAnimation: boolean;
}

/** Small 40x40 thumbnail that shows the trimmed content on a checkerboard. */
export function FrameThumb({ frame }: { frame: SourceFrameInfo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let live = true;
    loadImage(api.sourceUrl(frame))
      .then((image) => {
        if (!live) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = 40;
        canvas.height = 40;
        ctx.clearRect(0, 0, 40, 40);
        if (frame.empty) {
          ctx.strokeStyle = '#475569';
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(6.5, 6.5, 27, 27);
          ctx.setLineDash([]);
          return;
        }
        const scale = Math.min(38 / frame.sourceSize.width, 38 / frame.sourceSize.height);
        const w = frame.sourceSize.width * scale;
        const h = frame.sourceSize.height * scale;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, (40 - w) / 2, (40 - h) / 2, w, h);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [frame]);
  return <canvas ref={ref} className="thumb" width={40} height={40} />;
}

export function FrameRow(props: FrameRowProps) {
  const { frame, atlasFrame, selected, onSelect, onToggleAnimation, inAnimation } = props;
  // The relative path disambiguates same-named files from different folders.
  const pathLabel = frame.sourceKey !== frame.name ? frame.sourceKey : null;
  const flag = !atlasFrame
    ? '未打包'
    : atlasFrame.status === 'unplaced'
      ? '无法容纳'
      : `P${atlasFrame.page}${atlasFrame.rotation ? ` · 旋转 ${atlasFrame.rotation}°` : ''}`;
  return (
    <li className={`frame-row${selected ? ' selected' : ''}`} onClick={onSelect}>
      <FrameThumb frame={frame} />
      <div className="frame-row-main">
        <div className="frame-name" title={frame.sourceKey}>
          {frame.name}
          {frame.empty && <span className="badge badge-empty">全透明</span>}
        </div>
        {pathLabel && (
          <div className="frame-path mono" title={`目录：${pathLabel}`}>
            {pathLabel}
          </div>
        )}
        <div className="frame-meta mono">
          {frame.sourceSize.width}×{frame.sourceSize.height} px · 裁边 {frame.trim.x},{frame.trim.y}{' '}
          {frame.trim.width}×{frame.trim.height} px
        </div>
        <div className="frame-meta">
          <span className="mono id" title={frame.id}>{frame.id}</span>
          <span className={`pill ${atlasFrame?.status === 'unplaced' ? 'pill-bad' : 'pill-ok'}`}>{flag}</span>
        </div>
      </div>
      <button
        type="button"
        className={`icon-button${inAnimation ? ' active' : ''}`}
        title={
          !atlasFrame
            ? '先打包，再把它加入动画'
            : atlasFrame.status !== 'packed'
              ? '该帧未放置到页面，无法加入动画'
              : inAnimation
                ? '从动画中移除'
                : '加入动画序列'
        }
        disabled={!atlasFrame || atlasFrame.status !== 'packed'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleAnimation();
        }}
      >
        {inAnimation ? '−' : '+'}
      </button>
    </li>
  );
}

/** The atlas page with zoom, pan and click-to-select. */
export function AtlasPageView(props: {
  build: BuildResult;
  pageIndex: number;
  zoom: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showSourceOutline: boolean;
}) {
  const { build, pageIndex, zoom, selectedId, onSelect, showSourceOutline } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const page = build.pages[pageIndex];
  const [loaded, setLoaded] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!page) return;
    let live = true;
    setLoaded(null);
    setError(null);
    loadImage(page.url)
      .then((image) => {
        if (!live) return;
        const canvas = makeCanvas(image.naturalWidth, image.naturalHeight, 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(image, 0, 0);
        setLoaded(canvas);
      })
      .catch((caught: Error) => {
        if (live) setError(caught.message);
      });
    return () => {
      live = false;
    };
  }, [page?.url, page]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    const scale = zoom;
    canvas.width = Math.max(1, Math.round(page.width * scale));
    canvas.height = Math.max(1, Math.round(page.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Checkerboard: makes transparent pixels and edge extrusion visible.
    const cell = 8;
    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? '#111827' : '#1f2937';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    if (loaded) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(loaded, 0, 0, canvas.width, canvas.height);
    }
    // Margin guide.
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.setLineDash([6, 4]);
    const m = build.manifest.settings.margin * scale;
    ctx.strokeRect(m, m, page.width * scale - m * 2, page.height * scale - m * 2);
    ctx.setLineDash([]);

    for (const frame of build.manifest.frames) {
      if (frame.page !== pageIndex || !frame.packedRect) continue;
      const rect = frame.packedRect;
      const isSelected = frame.id === selectedId;
      if (frame.extrude > 0 || isSelected) {
        // Slot (content + extrusion) in yellow, content in blue: same meaning
        // with or without selection, only the weight changes.
        ctx.strokeStyle = isSelected ? '#fbbf24' : 'rgba(250, 204, 21, 0.4)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(rect.x * scale + 0.5, rect.y * scale + 0.5, rect.width * scale, rect.height * scale);
      }
      if (frame.contentRect) {
        ctx.strokeStyle = isSelected ? '#60a5fa' : 'rgba(96, 165, 250, 0.7)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(
          frame.contentRect.x * scale + 0.5,
          frame.contentRect.y * scale + 0.5,
          frame.contentRect.width * scale,
          frame.contentRect.height * scale,
        );
      }
      if (isSelected) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
        ctx.font = `${Math.max(11, 12 * Math.min(scale, 2))}px ui-monospace, monospace`;
        ctx.fillText(frame.name, rect.x * scale + 4, Math.max(12, rect.y * scale - 4));
      }
    }
    if (showSourceOutline) {
      // Map each frame's ORIGINAL canvas outline into page space: the trimmed
      // content sits at contentRect, so the source canvas extends around it by
      // the trim offsets (rotated clockwise together with the content).
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      for (const frame of build.manifest.frames) {
        if (frame.page !== pageIndex || !frame.contentRect || frame.empty) continue;
        const rect = sourceCanvasOutline(
          frame.contentRect,
          frame.rotation,
          frame.sourceSize,
          frame.trim,
        );
        if (!rect) continue;
        ctx.strokeStyle = frame.id === selectedId ? 'rgba(74, 222, 128, 0.95)' : 'rgba(74, 222, 128, 0.5)';
        ctx.strokeRect(rect.x * scale + 0.5, rect.y * scale + 0.5, rect.width * scale, rect.height * scale);
      }
      ctx.restore();
    }
  }, [build, pageIndex, zoom, selectedId, loaded, page, showSourceOutline]);

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!page) return;
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * page.width;
    const y = ((event.clientY - box.top) / box.height) * page.height;
    const hit = build.manifest.frames.find(
      (frame) =>
        frame.page === pageIndex &&
        frame.packedRect &&
        x >= frame.packedRect.x &&
        x < frame.packedRect.x + frame.packedRect.width &&
        y >= frame.packedRect.y &&
        y < frame.packedRect.y + frame.packedRect.height,
    );
    onSelect(hit && hit.id !== selectedId ? hit.id : null);
  };

  if (!page) return <p className="muted">没有页面</p>;
  return (
    <div className="page-view">
      <div className="page-scroll">
        <canvas ref={canvasRef} onClick={onCanvasClick} className="page-canvas" />
      </div>
      <div className="page-caption mono">
        第 {page.index + 1} / {build.manifest.pages.length} 页 · {page.width}×{page.height} px · 缩放{' '}
        {Math.round(zoom * 100)}%
        {error && <span className="error"> · {error}</span>}
      </div>
    </div>
  );
}

/** Side-by-side comparison: source canvas vs. reconstruction from the atlas. */
export function FrameCompare(props: {
  frame: SourceFrameInfo;
  atlasFrame: AtlasFrame;
  build: BuildResult;
  selected: boolean;
}) {
  const { frame, atlasFrame, build } = props;
  const leftRef = useRef<HTMLCanvasElement>(null);
  const rightRef = useRef<HTMLCanvasElement>(null);
  const [report, setReport] = useState<{ ok: boolean; text: string } | null>(null);
  const [scale, setScale] = useState(3);
  const size = atlasFrame.sourceSize;

  useEffect(() => {
    const maxW = 320;
    const maxH = 260;
    setScale(Math.max(1, Math.floor(Math.min(maxW / size.width, maxH / size.height) * 2) / 2));
  }, [size.width, size.height]);

  useEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return;
    let live = true;
    const setup = (canvas: HTMLCanvasElement) => {
      canvas.width = Math.max(1, Math.round(size.width * scale));
      canvas.height = Math.max(1, Math.round(size.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      return ctx;
    };

    const drawChecker = (ctx: CanvasRenderingContext2D) => {
      const cell = 8;
      for (let y = 0; y < ctx.canvas.height; y += cell) {
        for (let x = 0; x < ctx.canvas.width; x += cell) {
          ctx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? '#111827' : '#1f2937';
          ctx.fillRect(x, y, cell, cell);
        }
      }
    };

    Promise.all([loadImage(api.sourceUrl(frame)), atlasFrame.page !== null ? loadImage(build.pages[atlasFrame.page]?.url ?? '') : null])
      .then(async ([sourceImage, pageImage]) => {
        if (!live) return;
        const leftCtx = setup(left);
        const rightCtx = setup(right);
        if (!leftCtx || !rightCtx) return;
        drawChecker(leftCtx);
        drawChecker(rightCtx);
        leftCtx.drawImage(sourceImage, 0, 0, left.width, left.height);
        // Original-canvas outline on both sides.
        leftCtx.strokeStyle = 'rgba(148,163,184,0.9)';
        leftCtx.strokeRect(0.5, 0.5, left.width - 1, left.height - 1);

        const source = imageToRGBA(sourceImage);
        let reconstruction = { canvas: source, errors: [] as string[] };
        if (pageImage && atlasFrame.status === 'packed') {
          const pageRgba = imageToRGBA(pageImage);
          reconstruction = reconstructFrame(atlasFrame, pageRgba);
          drawRGBA(rightCtx, reconstruction.canvas, 0, 0, scale);
        } else if (atlasFrame.empty) {
          drawRGBA(rightCtx, reconstruction.canvas, 0, 0, scale);
        }
        rightCtx.strokeStyle = 'rgba(148,163,184,0.9)';
        rightCtx.strokeRect(0.5, 0.5, right.width - 1, right.height - 1);

        if (atlasFrame.status !== 'packed') {
          setReport({
            ok: false,
            text: `该帧未放置到任何页面。${(atlasFrame.issue ?? '超出页面容量').replace(/。$/, '')} 原图未改变，可增大页面尺寸或调整设置后重新打包。`,
          });
          return;
        }
        const comparison = compareImages(source, reconstruction.canvas);
        const identical = comparison.match && reconstruction.errors.length === 0;
        setReport({
          ok: identical,
          text: identical
            ? `像素一致（${size.width}×${size.height} px）${comparison.ignoredPixels ? `；忽略 ${comparison.ignoredPixels} 个全透明像素的 RGB` : ''}`
            : `不一致：${comparison.diffPixels} 个可见像素不同${reconstruction.errors[0] ? `；${reconstruction.errors[0]}` : ''}`,
        });
      })
      .catch((caught: Error) => {
        if (live) setReport({ ok: false, text: caught.message });
      });
    return () => {
      live = false;
    };
  }, [frame, atlasFrame, build, scale, size.width, size.height]);

  const trim = frame.trim;
  const infoRows: { key: string; value: string }[] = [
    { key: '原始画布', value: `${frame.sourceSize.width} × ${frame.sourceSize.height} px` },
    { key: '透明裁边', value: frame.empty ? '无内容（0 × 0 px）' : `x ${trim.x}, y ${trim.y} · ${trim.width} × ${trim.height} px` },
    { key: '页面位置', value: atlasFrame.packedRect ? `第 ${atlasFrame.page! + 1} 页 · x ${atlasFrame.packedRect.x}, y ${atlasFrame.packedRect.y}` : '未放置' },
    { key: '旋转方向', value: atlasFrame.rotation === 0 ? '未旋转' : `顺时针 ${atlasFrame.rotation}°` },
    { key: '扩展边', value: `${atlasFrame.extrude} px / 每边` },
    { key: '槽位尺寸', value: atlasFrame.packedRect ? `${atlasFrame.packedRect.width} × ${atlasFrame.packedRect.height} px` : '—' },
  ];

  return (
    <div className="compare">
      <div className="compare-grid">
        <figure>
          <canvas ref={leftRef} />
          <figcaption>原图（原始画布）</figcaption>
        </figure>
        <figure>
          <canvas ref={rightRef} />
          <figcaption>从图集还原</figcaption>
        </figure>
      </div>
      <p className={`compare-status ${report?.ok ? 'ok' : 'bad'}`}>
        {report ? report.text : '比较中…'} · 顺时针旋转 {atlasFrame.rotation}°
      </p>
      <dl className="info-grid">
        {infoRows.map((row) => (
          <div key={row.key}>
            <dt>{row.key}</dt>
            <dd className="mono">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function VerificationList({ report, compact }: { report: VerificationReport; compact?: boolean }) {
  return (
    <div className={`verification${report.ok ? ' ok' : ' bad'}`}>
      <div className="verification-head">
        <strong>{report.ok ? '自动验证通过' : '自动验证失败'}</strong>
        <span className="mono">
          {report.framesChecked} 帧 · {report.pagesChecked} 页 · 忽略透明 RGB {report.ignoredTransparentPixels} 像素
        </span>
      </div>
      <ul>
        {report.checks.map((check) => (
          <li key={check.id} className={check.ok ? 'pass' : 'fail'}>
            <span className="mono">{check.ok ? 'PASS' : 'FAIL'}</span> {check.label}
            {!compact && <span className="muted"> — {check.detail}</span>}
          </li>
        ))}
      </ul>
      {report.warnings.length > 0 && (
        <ul className="warnings">
          {report.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
