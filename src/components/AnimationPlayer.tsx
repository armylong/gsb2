import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnimationSpec, AtlasFrame, AtlasManifest } from '../../shared/types';
import { reconstructFrame } from '../../shared/reconstruct';
import type { RGBAImage } from '../../shared/pixels';
import { alignedOffset, animationDuration, unionCanvasSize } from '../../shared/animation';
import { imageToRGBA, loadImage, rgbaToCanvas } from '../lib/canvas';

export interface AnimationPlayerProps {
  manifest: AtlasManifest;
  spec: AnimationSpec;
  /** URL of the page PNG that contains a frame (atlas build or export bundle). */
  pageUrlFor: (frame: AtlasFrame) => string | null;
  zoom?: number;
  showCanvasOutline?: boolean;
}

interface PreparedFrame {
  frame: AtlasFrame;
  canvas: HTMLCanvasElement;
  durationMs: number;
}

/**
 * Plays an animation by reconstructing every frame from its page, then
 * aligning each ORIGINAL canvas on the shared normalized anchor. Atlas page
 * positions are never used for alignment, so trimming cannot cause jumps.
 */
export function AnimationPlayer(props: AnimationPlayerProps) {
  const { manifest, spec, pageUrlFor, zoom = 1, showCanvasOutline = true } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const [prepared, setPrepared] = useState<PreparedFrame[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const clock = useRef({ start: performance.now(), offset: 0, pausedAt: 0 });
  const preparedRef = useRef<PreparedFrame[] | null>(null);
  const playingRef = useRef(true);

  const frames = useMemo(() => {
    const byId = new Map(manifest.frames.map((frame) => [frame.id, frame]));
    return spec.frames
      .map((ref) => ({ ref, frame: byId.get(ref.id) }))
      .filter((entry): entry is { ref: (typeof spec.frames)[number]; frame: AtlasFrame } => Boolean(entry.frame));
  }, [manifest, spec]);

  const missingIds = useMemo(
    () => spec.frames.filter((ref) => !manifest.frames.some((frame) => frame.id === ref.id)).map((ref) => ref.id),
    [manifest, spec],
  );
  const stage = useMemo(() => unionCanvasSize(frames.map((entry) => entry.frame)), [frames]);
  const totalMs = Math.max(1, animationDuration(spec));

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    clock.current = { start: performance.now(), offset: 0, pausedAt: 0 };
    setPlaying(true);
    setFrameIndex(0);
  }, [spec]);

  // Decode pages once, then reconstruct every frame onto its original canvas.
  useEffect(() => {
    let live = true;
    setPrepared(null);
    preparedRef.current = null;
    setLoadError(null);
    const urls = new Set<string>();
    for (const { frame } of frames) {
      const url = frame.page === null ? null : pageUrlFor(frame);
      if (url) urls.add(url);
    }
    (async () => {
      const pages = new Map<string, RGBAImage>();
      for (const url of urls) {
        const image = await loadImage(url);
        pages.set(url, imageToRGBA(image));
      }
      const list: PreparedFrame[] = [];
      for (const { frame, ref } of frames) {
        const url = frame.page === null ? null : pageUrlFor(frame);
        const page = url ? pages.get(url) ?? null : null;
        const rebuilt = reconstructFrame(frame, page);
        if (rebuilt.errors.length > 0) throw new Error(rebuilt.errors[0]);
        list.push({ frame, canvas: rgbaToCanvas(rebuilt.canvas), durationMs: ref.durationMs });
      }
      if (!live) return;
      preparedRef.current = list;
      setPrepared(list);
    })().catch((error: Error) => {
      if (live) setLoadError(error.message);
    });
    return () => {
      live = false;
    };
  }, [frames, pageUrlFor]);

  useEffect(() => {
    let handle = 0;
    const scale = zoom;
    const draw = () => {
      const list = preparedRef.current;
      const canvas = canvasRef.current;
      if (canvas && list && list.length > 0) {
        const now = performance.now();
        let elapsedMs = clock.current.pausedAt;
        if (playingRef.current) {
          const accumulated = clock.current.offset + (now - clock.current.start);
          if (!spec.loop && accumulated >= totalMs) {
            clock.current.pausedAt = totalMs - 1;
            elapsedMs = totalMs - 1;
            playingRef.current = false;
            setPlaying(false);
          } else {
            elapsedMs = accumulated % totalMs;
          }
        }
        let index = 0;
        let cursor = elapsedMs;
        for (let i = 0; i < list.length; i++) {
          index = i;
          if (cursor < list[i].durationMs) break;
          cursor -= list[i].durationMs;
        }
        const entry = list[index];
        const width = Math.round(stage.width * scale);
        const height = Math.round(stage.height * scale);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, width, height);
          const offset = alignedOffset(entry.frame.sourceSize, stage, spec.anchor);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(
            entry.canvas,
            offset.x * scale,
            offset.y * scale,
            entry.frame.sourceSize.width * scale,
            entry.frame.sourceSize.height * scale,
          );
          if (showCanvasOutline) {
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(
              offset.x * scale + 0.5,
              offset.y * scale + 0.5,
              entry.frame.sourceSize.width * scale - 1,
              entry.frame.sourceSize.height * scale - 1,
            );
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
            ctx.fillRect(spec.anchor.x * stage.width * scale - 3, spec.anchor.y * stage.height * scale - 3, 6, 6);
          }
        }
        setFrameIndex((previous) => (previous === index ? previous : index));
        if (clockRef.current) {
          clockRef.current.textContent = `${Math.round(elapsedMs)} / ${totalMs} ms`;
        }
      }
      handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [prepared, spec.anchor, spec.loop, stage, totalMs, zoom, showCanvasOutline]);

  const toggle = () => {
    const now = performance.now();
    if (playingRef.current) {
      const elapsedMs = (clock.current.offset + (now - clock.current.start)) % totalMs;
      clock.current.pausedAt = elapsedMs;
      playingRef.current = false;
      setPlaying(false);
    } else {
      clock.current.start = now;
      clock.current.offset = clock.current.pausedAt;
      playingRef.current = true;
      setPlaying(true);
    }
  };

  const restart = () => {
    clock.current = { start: performance.now(), offset: 0, pausedAt: 0 };
    playingRef.current = true;
    setPlaying(true);
    setFrameIndex(0);
  };

  return (
    <div className="player">
      <div className="player-stage">
        <canvas ref={canvasRef} />
      </div>
      <div className="player-controls">
        <button type="button" className="button small" onClick={toggle} disabled={!prepared}>
          {playing ? '暂停' : '播放'}
        </button>
        <button type="button" className="button small" onClick={restart} disabled={!prepared}>
          重播
        </button>
        <span className="mono">
          第 {Math.max(1, frameIndex + 1)} / {frames.length} 帧 · <span ref={clockRef}>0 / {totalMs} ms</span>
          {spec.loop ? ' · 循环' : ' · 单次'}
        </span>
      </div>
      <div className="player-caption mono">
        {frames.length} 帧 · 总时长 {totalMs} ms · 锚点 ({spec.anchor.x.toFixed(2)}, {spec.anchor.y.toFixed(2)}) ·
        统一原始画布 {stage.width}×{stage.height} px
      </div>
      {missingIds.length > 0 && (
        <p className="error">
          动画引用了当前图集中不存在的帧标识：{missingIds.slice(0, 3).join(', ')}
          {missingIds.length > 3 ? ` 等 ${missingIds.length} 个` : ''}
        </p>
      )}
      {loadError && <p className="error">无法还原动画：{loadError}</p>}
      {!prepared && !loadError && <p className="muted">正在从图集页面还原各帧…</p>}
    </div>
  );
}

/** A compact strip listing the animation frames, with durations. */
export function AnimationStrip(props: {
  manifest: AtlasManifest;
  spec: AnimationSpec;
  onSelect?: (id: string) => void;
}) {
  const { manifest, spec, onSelect } = props;
  const byId = useMemo(() => new Map(manifest.frames.map((frame) => [frame.id, frame])), [manifest]);
  return (
    <ol className="anim-strip">
      {spec.frames.map((ref, index) => {
        const frame = byId.get(ref.id);
        return (
          <li key={`${ref.id}-${index}`} onClick={() => onSelect?.(ref.id)}>
            <span className="mono">{index + 1}</span>
            <span>{frame?.name ?? ref.id}</span>
            <span className="mono muted">{ref.durationMs} ms</span>
          </li>
        );
      })}
    </ol>
  );
}
