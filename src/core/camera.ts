import { clamp, lerp } from './math.ts';
import type {
  CameraConfig,
  ClipInfo,
  LimitReason,
  Rect,
  Vec2,
} from './types.ts';

export interface CameraDiagnostic {
  cx: number;
  cy: number;
  zoom: number;
  desiredCx: number;
  desiredCy: number;
  desiredZoom: number;
  view: Rect;
  clips: ClipInfo[];
  limits: LimitReason[];
}

/**
 * 镜头装置: 纯逻辑, 不依赖 DOM / Canvas, 便于在 Node 下做确定性验证。
 *
 * 坐标约定: 世界单位 -> 逻辑像素, zoom 单位为 "世界单位 / 像素"。
 * zoom 越小 = 看得越近(放大), zoom 越大 = 看得越远(缩小)。
 */
export class CameraRig {
  config: CameraConfig;
  readonly viewportW: number;
  readonly viewportH: number;

  cx = 0;
  cy = 0;
  zoom = 1;
  private initialized = false;

  constructor(config: CameraConfig, viewportW: number, viewportH: number) {
    this.config = config;
    this.viewportW = viewportW;
    this.viewportH = viewportH;
  }

  /** 直接对齐到某个状态(首次跟随 / 重置时使用, 保证入画不突跳) */
  snap(cx: number, cy: number, zoom: number): void {
    this.cx = cx;
    this.cy = cy;
    this.zoom = zoom;
    this.initialized = true;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** 当前视口在世界坐标中的矩形 */
  viewRect(): Rect {
    return {
      x: this.cx - (this.zoom * this.viewportW) / 2,
      y: this.cy - (this.zoom * this.viewportH) / 2,
      w: this.zoom * this.viewportW,
      h: this.zoom * this.viewportH,
    };
  }

  screenToWorld(p: Vec2): Vec2 {
    return {
      x: this.cx + (p.x - this.viewportW / 2) * this.zoom,
      y: this.cy + (p.y - this.viewportH / 2) * this.zoom,
    };
  }

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.cx) / this.zoom + this.viewportW / 2,
      y: (p.y - this.cy) / this.zoom + this.viewportH / 2,
    };
  }

  /**
   * 根据跟随目标计算"理想镜头"并做缩放/平移钳制。
   * @param targets 跟随名单内角色的世界坐标
   */
  private computeDesired(targets: Vec2[]): {
    cx: number;
    cy: number;
    zoom: number;
    limits: LimitReason[];
  } {
    const cfg = this.config;
    const limits: LimitReason[] = [];

    if (targets.length === 0) {
      // 名单为空: 镜头保持不动, 不产生任何期望位移
      return { cx: this.cx, cy: this.cy, zoom: this.zoom, limits };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of targets) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const bboxCx = (minX + maxX) / 2;
    const bboxCy = (minY + maxY) / 2;

    // 安全区: 目标必须落在屏幕中部的安全框内
    const usableW = this.viewportW * (1 - 2 * cfg.safeMargin.x);
    const usableH = this.viewportH * (1 - 2 * cfg.safeMargin.y);

    // 单点时 span 为 0, 直接取最大放大倍率
    const rawFit =
      spanX === 0 && spanY === 0
        ? cfg.maxZoom
        : Math.max(spanX / usableW, spanY / usableH);

    if (rawFit < cfg.minZoom) limits.push('MIN_ZOOM');
    if (rawFit > cfg.maxZoom) limits.push('MAX_ZOOM');
    const zoom = clamp(rawFit, cfg.minZoom, cfg.maxZoom);

    // 平移范围: 视口半宽/半高随缩放变化, 钳制镜头中心
    const halfW = (zoom * this.viewportW) / 2;
    const halfH = (zoom * this.viewportH) / 2;
    const b = cfg.panBounds;
    const loX = b.x + halfW;
    const hiX = b.x + b.w - halfW;
    const loY = b.y + halfH;
    const hiY = b.y + b.h - halfH;

    let cx: number;
    let cy: number;
    if (loX >= hiX) {
      // 视口比活动范围还宽: 居中并报告平移触限
      cx = b.x + b.w / 2;
      limits.push('PAN_LIMIT_X');
    } else {
      cx = clamp(bboxCx, loX, hiX);
      if (cx !== bboxCx) limits.push('PAN_LIMIT_X');
    }
    if (loY >= hiY) {
      cy = b.y + b.h / 2;
      limits.push('PAN_LIMIT_Y');
    } else {
      cy = clamp(bboxCy, loY, hiY);
      if (cy !== bboxCy) limits.push('PAN_LIMIT_Y');
    }

    return { cx, cy, zoom, limits };
  }

  private computeClips(
    view: Rect,
    allActors: Array<{ id: string; x: number; y: number; radius: number }>,
  ): ClipInfo[] {
    const clips: ClipInfo[] = [];
    for (const a of allActors) {
      const sides: ClipInfo['sides'] = [];
      if (a.x - a.radius < view.x) sides.push('left');
      if (a.x + a.radius > view.x + view.w) sides.push('right');
      if (a.y - a.radius < view.y) sides.push('top');
      if (a.y + a.radius > view.y + view.h) sides.push('bottom');
      if (sides.length > 0) clips.push({ actorId: a.id, sides });
    }
    return clips;
  }

  /**
   * 按当前 zoom 重新把镜头中心钳回平移范围。
   * 平滑过程中 zoom 与中心同时变化, 旧中心可能落在新视口的允许区间之外,
   * 因此每个固定步长结束后都要重新钳制, 保证视口永不越界。
   */
  private clampCenterToCurrentZoom(): void {
    const halfW = (this.zoom * this.viewportW) / 2;
    const halfH = (this.zoom * this.viewportH) / 2;
    const b = this.config.panBounds;
    const loX = b.x + halfW;
    const hiX = b.x + b.w - halfW;
    const loY = b.y + halfH;
    const hiY = b.y + b.h - halfH;
    this.cx = loX >= hiX ? b.x + b.w / 2 : clamp(this.cx, loX, hiX);
    this.cy = loY >= hiY ? b.y + b.h / 2 : clamp(this.cy, loY, hiY);
  }

  /**
   * 推进一个固定步长。
   * @param dt 固定步长(秒)
   * @param followTargets 跟随名单内角色坐标
   * @param allActors 全部角色坐标 + 半径, 用于裁切诊断
   */
  update(
    dt: number,
    followTargets: Vec2[],
    allActors: Array<{ id: string; x: number; y: number; radius: number }>,
  ): CameraDiagnostic {
    const desired = this.computeDesired(followTargets);

    // 名单为空: 镜头冻结, 既不平滑也不重新钳制, 视口与诊断保持原样
    if (followTargets.length === 0) {
      const view = this.viewRect();
      const clips = this.computeClips(view, allActors);
      return {
        cx: this.cx,
        cy: this.cy,
        zoom: this.zoom,
        desiredCx: desired.cx,
        desiredCy: desired.cy,
        desiredZoom: desired.zoom,
        view,
        clips,
        limits: desired.limits,
      };
    }

    if (!this.initialized) {
      this.snap(desired.cx, desired.cy, desired.zoom);
    } else {
      // 平滑系数:
      //  exp      -> 帧率无关, alpha 由真实时间 dt 决定, 不同帧率收敛一致
      //  per-tick -> 每个固定步长吃同一比例, 帧率越低滞后越大(用于暴露问题)
      let alpha: number;
      if (this.config.smoothing >= 1) alpha = 1;
      else if (this.config.smoothingMode === 'exp') {
        const rate = this.config.smoothing * 10; // 0~1 => 0~10 /秒
        alpha = 1 - Math.exp(-rate * dt);
      } else {
        alpha = this.config.smoothing;
      }
      this.cx = lerp(this.cx, desired.cx, alpha);
      this.cy = lerp(this.cy, desired.cy, alpha);
      this.zoom = lerp(this.zoom, desired.zoom, alpha);
    }
    this.clampCenterToCurrentZoom();

    const view = this.viewRect();
    const clips = this.computeClips(view, allActors);

    return {
      cx: this.cx,
      cy: this.cy,
      zoom: this.zoom,
      desiredCx: desired.cx,
      desiredCy: desired.cy,
      desiredZoom: desired.zoom,
      view,
      clips,
      limits: desired.limits,
    };
  }
}
