import { Vector3 } from 'three';
import { VERIFY_VIEW } from './types';
import type { ViewMode } from './types';
import type { App } from './main';
import type { AoPipeline } from './aoPipeline';

export interface CheckResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
}

type RGB = [number, number, number];

function rgbOf(buf: Uint8Array): RGB {
  return [buf[0], buf[1], buf[2]];
}

function rgbText(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function dist(a: RGB, b: RGB): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/**
 * 固定观察点验证。
 * 验证期间临时切到悬空球场景、单画面模式，结束后完整恢复用户现场。
 * 所有读数来自当前画布真实像素（gl.readPixels），可重复对照。
 */
export class Validator {
  constructor(
    private readonly app: App,
    private readonly pipeline: AoPipeline,
  ) {}

  private renderSingle(mode: ViewMode, intensity: number, gap: number): void {
    this.app.applyVerifyState({ mode, intensity, gap });
    const { width, height } = this.app.getDrawingSize();
    this.pipeline.setParams(
      this.app.getParams().radius,
      this.app.getParams().depthBias,
      this.app.getParams().smooth,
    );
    this.pipeline.prepare();
    this.pipeline.blit(mode, intensity, { x: 0, y: 0, w: width, h: height });
  }

  /** 在画面上半区扫描一个真正的空背景像素（设备深度 == 1），避免误取到墙面 */
  private findBackgroundNdc(): { x: number; y: number } {
    for (let i = 0; i < 60; i++) {
      const x = -0.85 + (i % 10) * 0.19;
      const y = 0.25 + Math.floor(i / 10) * 0.17;
      const d = this.pipeline.readDepth(x, y);
      if (d >= 0.9995) return { x, y };
    }
    // 兜底：画面最顶部通常是天空
    return { x: 0, y: 0.92 };
  }

  run(): CheckResult[] {
    const state = this.app.getState();
    const results: CheckResult[] = [];
    try {
      this.app.setViewpoint(VERIFY_VIEW.position, VERIFY_VIEW.target);
      const sphere = this.app.getSphereMesh()!;
      const radius = sphere.userData.radius as number;

      // 地面点：接触点在球正下方；空旷点远离球体投影；V6 复用同一地面点
      const contactWorld = new Vector3(0, 0.012, 0);
      const openWorld = new Vector3(5.5, 0.012, 4.5);
      // 球面平坦区：球心朝相机方向的正面点，远离轮廓与底部接触区
      const camDir = new Vector3(...VERIFY_VIEW.position)
        .sub(new Vector3(0, sphere.position.y, 0))
        .normalize();
      const sphereSideWorld = new Vector3(0, sphere.position.y, 0).addScaledVector(camDir, radius * 0.55);

      const read = (world: Vector3): RGB => {
        const ndc = this.pipeline.projectToNdc(world);
        return rgbOf(this.pipeline.readPixel(ndc.x, ndc.y));
      };

      const params = state.params;

      // ---- 基准：关闭遮蔽 ----
      this.renderSingle('off', params.intensity, params.gap);
      const bgNdc = this.findBackgroundNdc();
      const readBg = (): RGB => rgbOf(this.pipeline.readPixel(bgNdc.x, bgNdc.y));
      const offContact = read(contactWorld);
      const offOpen = read(openWorld);
      const offBg = readBg();
      const offSphereSide = read(sphereSideWorld);

      // ---- V1 开启后：接触区变暗、空旷地面与球面基本不变 ----
      this.renderSingle('on', params.intensity, params.gap);
      const onContact = read(contactWorld);
      const onOpen = read(openWorld);
      const onSphereSide = read(sphereSideWorld);
      const contactDarken = dist(offContact, onContact);
      const openDelta = dist(offOpen, onOpen);
      const sphereDelta = dist(offSphereSide, onSphereSide);
      results.push({
        id: 'V1',
        name: '开启遮蔽：接触区变暗，无邻近遮挡处基本保持原亮度',
        pass: contactDarken >= 12 && openDelta <= 10 && sphereDelta <= 16,
        detail:
          `接触区 ${rgbText(offContact)} → ${rgbText(onContact)}（变化 ${contactDarken}，阈值≥12）；` +
          `空旷地面变化 ${openDelta}（≤10）；球面变化 ${sphereDelta}（≤16）`,
      });

      // ---- V2 强度 0 与关闭遮蔽完全一致 ----
      this.renderSingle('on', 0, params.gap);
      const zeroContact = read(contactWorld);
      const zeroBg = readBg();
      const dZero = dist(offContact, zeroContact) + dist(offBg, zeroBg);
      results.push({
        id: 'V2',
        name: '强度 = 0 时与“关闭遮蔽”像素一致',
        pass: dZero === 0,
        detail: `接触区 ${rgbText(zeroContact)} vs 关闭 ${rgbText(offContact)}；背景 ${rgbText(zeroBg)} vs ${rgbText(offBg)}；总差异 ${dZero}（要求 0）`,
      });

      // ---- V3 球体贴近 vs 抬升：接触区亮度差显著且方向正确 ----
      this.renderSingle('on', params.intensity, 0.02);
      const near = read(contactWorld);
      this.renderSingle('on', params.intensity, 2.5);
      const far = read(contactWorld);
      const nearSum = near[0] + near[1] + near[2];
      const farSum = far[0] + far[1] + far[2];
      results.push({
        id: 'V3',
        name: '球体贴近时接触区更暗，抬升后暗部减弱',
        pass: farSum - nearSum >= 24,
        detail: `gap=0.02 时 ${rgbText(near)}（和 ${nearSum}）；gap=2.5 时 ${rgbText(far)}（和 ${farSum}）；差 ${farSum - nearSum}（阈值≥24）`,
      });

      // ---- V4 灰度图：真实空背景保持纯白；贴近状态下接触区为灰度暗部 ----
      this.renderSingle('gray', params.intensity, 0.02);
      const grayBg = readBg();
      const grayContact = read(contactWorld);
      const isGray =
        Math.abs(grayContact[0] - grayContact[1]) <= 2 && Math.abs(grayContact[1] - grayContact[2]) <= 2;
      results.push({
        id: 'V4',
        name: '灰度图：空背景不被当成近处表面（保持白），接触区为灰度暗部',
        pass: grayBg[0] >= 250 && grayBg[1] >= 250 && grayBg[2] >= 250 && isGray && grayContact[0] <= 242,
        detail: `背景 ${rgbText(grayBg)}（要求≥250，扫描 NDC=${bgNdc.x.toFixed(2)},${bgNdc.y.toFixed(2)}）；gap=0.02 接触区 ${rgbText(grayContact)}（灰度 R≈G≈B=${isGray}，且 <235）`,
      });

      // ---- V5 半径增大：接触区暗部加深或持平，不会整体涂黑 ----
      const { width, height } = this.app.getDrawingSize();
      const renderWithRadius = (r: number): RGB => {
        this.app.applyVerifyState({ mode: 'on', intensity: params.intensity, gap: params.gap });
        this.pipeline.setParams(r, params.depthBias, params.smooth);
        this.pipeline.prepare();
        this.pipeline.blit('on', params.intensity, { x: 0, y: 0, w: width, h: height });
        return read(contactWorld);
      };
      const smallR = renderWithRadius(2);
      const bigR = renderWithRadius(16);
      const openBig = read(openWorld);
      results.push({
        id: 'V5',
        name: '半径增大补层次而非涂黑：接触区加深，空旷地面仍接近原图',
        pass:
          smallR[0] + smallR[1] + smallR[2] >= bigR[0] + bigR[1] + bigR[2] &&
          dist(offOpen, openBig) <= 14,
        detail:
          `半径 2 → 16 接触区 ${rgbText(smallR)} → ${rgbText(bigR)}；` +
          `空旷地面与原图差异 ${dist(offOpen, openBig)}（≤14）`,
      });

      // ---- V6 球体移开后无残留：同一地面点回到接近原始光照 ----
      this.pipeline.setParams(params.radius, params.depthBias, params.smooth);
      this.renderSingle('on', params.intensity, 2.5);
      const far2 = read(contactWorld);
      // 抬升后该点不再受球影响，与“关闭遮蔽”同一点比较
      this.renderSingle('off', params.intensity, 2.5);
      const offFar = read(contactWorld);
      const residual = dist(offFar, far2);
      results.push({
        id: 'V6',
        name: '物体移开后无残留旧暗影（实时深度驱动）',
        pass: residual <= 12,
        detail: `抬升到 gap=2.5 后地面点 ${rgbText(far2)}，与同位置关闭遮蔽 ${rgbText(offFar)} 差异 ${residual}（≤12）`,
      });

      // ---- V7 背景边界：开启模式下背景与关闭模式同色，无黑块扩散 ----
      this.renderSingle('on', params.intensity, params.gap);
      const onBg = readBg();
      const bgDelta = dist(offBg, onBg);
      results.push({
        id: 'V7',
        name: '物体边缘不向背景扩散黑块',
        pass: bgDelta <= 6,
        detail: `开启遮蔽背景 ${rgbText(onBg)} vs 关闭 ${rgbText(offBg)}，差异 ${bgDelta}（≤6）`,
      });
    } finally {
      this.app.restoreVerifyState(state);
    }
    return results;
  }
}
