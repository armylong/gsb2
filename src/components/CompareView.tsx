import { useEffect, useRef, useState } from 'react';
import { LutRenderer } from '../webgl/renderer';
import type { Lut3D } from '../lut/cubeParser';
import type { ColorSpaceMode, Interpolation } from '../lut/applyLut';
import type { ImageState } from '../types';

interface Props {
  image: ImageState | null;
  lut: Lut3D | null;
  interpolation: Interpolation;
  mode: ColorSpaceMode;
  strength: number;
  onPick: (x: number, y: number) => void;
}

interface ViewState {
  divider: number;
  zoom: number;
  panX: number; // 屏幕中心对应的图片 x(像素)
  panY: number;
}

interface DragState {
  kind: 'divider' | 'pan';
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
}

/** 原图 | 结果 并排对比视图:单画布渲染,分界线左侧原图、右侧结果,天然同步缩放 */
export function CompareView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LutRenderer | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>({ divider: 0.5, zoom: 1, panX: 0, panY: 0 });
  const propsRef = useRef(props);
  propsRef.current = props;
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<DragState | null>(null);

  const renderNow = () => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    const img = propsRef.current.image;
    if (!r || !c || !img) return;
    const cssW = c.clientWidth;
    const cssH = c.clientHeight;
    if (!cssW || !cssH) return;
    r.resize();
    const v = viewRef.current;
    const fit = Math.min(cssW / img.width, cssH / img.height);
    const scale = fit * v.zoom; // 每图片像素对应的 css 像素
    const uvScale: [number, number] = [cssW / (img.width * scale), cssH / (img.height * scale)];
    const uvOffset: [number, number] = [
      v.panX / img.width - uvScale[0] / 2,
      v.panY / img.height - uvScale[1] / 2,
    ];
    r.render({
      mode: propsRef.current.mode,
      interpolation: propsRef.current.interpolation,
      strength: propsRef.current.strength,
      divider: v.divider,
      uvScale,
      uvOffset,
    });
  };
  const renderRef = useRef(renderNow);
  renderRef.current = renderNow;

  // 初始化渲染器 + 监听画布尺寸
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = new LutRenderer(canvas);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }
    const ro = new ResizeObserver(() => renderRef.current());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // 图片变化:上传纹理并重置视图
  useEffect(() => {
    const img = props.image;
    if (rendererRef.current && img) {
      rendererRef.current.setImage(img.data, img.width, img.height);
      setView((v) => ({ ...v, zoom: 1, panX: img.width / 2, panY: img.height / 2 }));
    }
  }, [props.image]);

  // 色表变化:立即替换三维纹理,画面始终对应最新色表
  useEffect(() => {
    if (props.lut) rendererRef.current?.setLut(props.lut);
    else rendererRef.current?.clearLut();
  }, [props.lut]);

  // 每次状态变化后重绘
  useEffect(() => {
    renderRef.current();
  });

  // 滚轮缩放(以光标为中心),需要非 passive 监听
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const img = propsRef.current.image;
      if (!img) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewRef.current;
      const fit = Math.min(rect.width / img.width, rect.height / img.height);
      const oldScale = fit * v.zoom;
      const zoom = Math.min(80, Math.max(0.05, v.zoom * Math.exp(-e.deltaY * 0.0015)));
      const newScale = fit * zoom;
      const imgX = (mx - rect.width / 2) / oldScale + v.panX;
      const imgY = (my - rect.height / 2) / oldScale + v.panY;
      setView({
        ...v,
        zoom,
        panX: imgX - (mx - rect.width / 2) / newScale,
        panY: imgY - (my - rect.height / 2) / newScale,
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !propsRef.current.image) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const v = viewRef.current;
    const kind = Math.abs(x - v.divider * rect.width) < 8 ? 'divider' : 'pan';
    dragRef.current = { kind, startX: x, startY: y, panX: v.panX, panY: v.panY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const v = viewRef.current;
    if (Math.abs(x - d.startX) + Math.abs(y - d.startY) > 3) d.moved = true;
    if (d.kind === 'divider') {
      setView({ ...v, divider: Math.min(0.98, Math.max(0.02, x / rect.width)) });
    } else {
      const img = propsRef.current.image;
      if (!img) return;
      const fit = Math.min(rect.width / img.width, rect.height / img.height);
      const scale = fit * v.zoom;
      setView({ ...v, panX: d.panX - (x - d.startX) / scale, panY: d.panY - (y - d.startY) / scale });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved || d.kind === 'divider') return;
    const img = propsRef.current.image;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const v = viewRef.current;
    const fit = Math.min(rect.width / img.width, rect.height / img.height);
    const scale = fit * v.zoom;
    const ix = Math.floor((x - rect.width / 2) / scale + v.panX);
    const iy = Math.floor((y - rect.height / 2) / scale + v.panY);
    if (ix >= 0 && iy >= 0 && ix < img.width && iy < img.height) {
      propsRef.current.onPick(ix, iy);
    }
  };

  if (glError) {
    return <div className="compare-message error">WebGL2 初始化失败:{glError}</div>;
  }
  if (!props.image) {
    return <div className="compare-message">请先载入图片(可用左侧"示例素材"一键载入)</div>;
  }
  return (
    <div className="compare-wrap">
      <canvas
        ref={canvasRef}
        className="compare-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="compare-hud">
        左:原图 · 右:结果 | 缩放 {(view.zoom * 100).toFixed(0)}% | 拖动竖线移动分界 · 拖动画面平移 ·
        滚轮缩放 · 单击查看像素数值
      </div>
    </div>
  );
}
