// Pure simulation state: camera + two independently translating opaque layers.
// All positions are in world pixels. The screen origin in world space is `cam`.

export interface SimState {
  frame: number;
  camX: number;
  camY: number;
  prevCamX: number;
  prevCamY: number;
  midX: number;
  midY: number;
  fgX: number;
  fgY: number;
  fgVisible: number; // 1 or 0
}

export interface SimConfig {
  width: number;
  height: number;
  // per-frame world velocities
  camVx: number;
  camVy: number;
  midVx: number;
  midVy: number;
  fgVx: number;
  fgVy: number;
}

export function createInitialState(cfg: SimConfig): SimState {
  const { width, height } = cfg;
  return {
    frame: 0,
    camX: 0,
    camY: 0,
    prevCamX: 0,
    prevCamY: 0,
    midX: width * 0.32,
    midY: height * 0.52,
    fgX: width * 0.62,
    fgY: height * 0.5,
    fgVisible: 1,
  };
}

export function createConfig(width: number, height: number): SimConfig {
  return {
    width,
    height,
    camVx: 1.6,
    camVy: 0.45,
    midVx: -1.1,
    midVy: 0.35,
    fgVx: -2.3,
    fgVy: -0.25,
  };
}

/** Constant-velocity step; manual camera edits go through applyCameraEdit instead. */
export function step(s: SimState, cfg: SimConfig): SimState {
  s.prevCamX = s.camX;
  s.prevCamY = s.camY;
  s.camX += cfg.camVx;
  s.camY += cfg.camVy;
  s.midX += cfg.midVx;
  s.midY += cfg.midVy;
  s.fgX += cfg.fgVx;
  s.fgY += cfg.fgVy;
  s.frame += 1;
  return s;
}

/**
 * Manual camera edit (jump button or drag). prevCam is deliberately NOT updated
 * to the new position, so camDelta reflects the discontinuity and the temporal
 * pass invalidates the covered pixels; the history caches are also cleared.
 */
export function applyCameraEdit(s: SimState, dx: number, dy: number): void {
  s.camX += dx;
  s.camY += dy;
}

/** Ease-in-out cubic. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface Clip {
  id: string;
  label: string;
  description: string;
  duration: number;
  init: (s: SimState, cfg: SimConfig) => void;
  /** Called once per frame before step() semantics; returns the state to render. */
  apply: (s: SimState, cfg: SimConfig, f: number) => void;
}

/** Clip 1: non-linear camera glide (easing) + constant layer translation. */
const easingClip: Clip = {
  id: 'easing',
  label: '缓动片段',
  description:
    '相机按 ease-in-out 滑行，两层图形保持各自匀速平移；前段验证多帧合成的抑闪效果，停止后的尾部用于读出拖影收敛帧数。',
  duration: 210,
  init(s, cfg) {
    s.camX = -cfg.width * 0.35;
    s.camY = -cfg.height * 0.12;
    s.prevCamX = s.camX;
    s.prevCamY = s.camY;
    s.fgVisible = 1;
  },
  apply(s, cfg, f) {
    const moveFrames = 130;
    const startX = -cfg.width * 0.35;
    const startY = -cfg.height * 0.12;
    const distX = cfg.width * 0.9;
    const distY = cfg.height * 0.34;
    const t = Math.min(f / moveFrames, 1);
    const e = easeInOut(t);
    // Set absolute camera position; prev* still holds last frame's position,
    // so the reproject delta stays exact for every eased sub-step.
    s.camX = startX + distX * e;
    s.camY = startY + distY * e;
    if (f < moveFrames) {
      s.midX += cfg.midVx;
      s.midY += cfg.midVy;
      s.fgX += cfg.fgVx;
      s.fgY += cfg.fgVy;
    }
    s.frame += 1;
  },
};

/** Clip 2: foreground slides off (or vanishes) revealing the background beneath. */
function buildOcclusionClip(sudden: boolean): Clip {
  const settleAt = 115; // from this frame on, camera and layers stand still
  return {
    id: sudden ? 'occlusion-sudden' : 'occlusion-slide',
    label: sudden ? '遮挡揭开（突然消失）' : '遮挡揭开（滑开）',
    description: sudden
      ? '前景在第 60 帧瞬间消失，被遮挡区域没有可用历史，应整区取新画面；第 115 帧起全部静止，尾部用于读出拖影收敛帧数。'
      : '前景匀速滑开测量区，逐行揭开背景；揭开位置按图层 id 判定为失配并取新画面，第 115 帧起静止并观察收敛。',
    duration: 180,
    init(s, cfg) {
      s.camX = 0;
      s.camY = 0;
      s.prevCamX = 0;
      s.prevCamY = 0;
      s.fgVisible = 1;
      // Park the foreground panel so it fully covers the ROI at frame 0.
      s.fgX = cfg.width * 0.40;
      s.fgY = cfg.height * 0.50;
      s.midX = cfg.width * 0.30;
      s.midY = cfg.height * 0.52;
    },
    apply(s, cfg, f) {
      s.prevCamX = s.camX;
      s.prevCamY = s.camY;
      const moving = f < settleAt;
      if (moving) {
        s.camX += cfg.camVx;
        s.camY += cfg.camVy;
        s.midX += cfg.midVx;
        s.midY += cfg.midVy;
      }
      if (sudden) {
        if (f === 60) s.fgVisible = 0;
      } else if (moving) {
        s.fgX += cfg.fgVx * 1.6;
        s.fgY += cfg.fgVy;
      }
      s.frame += 1;
    },
  };
}

export const CLIPS: Clip[] = [
  easingClip,
  buildOcclusionClip(false),
  buildOcclusionClip(true),
];

/** Measurement region in viewport fraction (x0,y0,x1,y1), origin bottom-left. */
export const ROI_FRAC = { x0: 0.34, y0: 0.44, x1: 0.46, y1: 0.56 };

export function roiPixels(width: number, height: number): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(width * ROI_FRAC.x0),
    y: Math.round(height * ROI_FRAC.y0),
    w: Math.round(width * (ROI_FRAC.x1 - ROI_FRAC.x0)),
    h: Math.round(height * (ROI_FRAC.y1 - ROI_FRAC.y0)),
  };
}
