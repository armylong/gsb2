import type { RGBAImage } from '../core/image.ts';
import { runAtlasChecks } from '../core/atlasChecks.ts';

function imageCanvas(image: RGBAImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.className = 'pixel-canvas';
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const copy = new Uint8ClampedArray(image.data);
  ctx.putImageData(new ImageData(copy, image.width, image.height), 0, 0);
  return canvas;
}

function imageTile(image: RGBAImage, caption: string): HTMLElement {
  const tile = document.createElement('figure');
  tile.className = 'mip-tile';
  tile.appendChild(imageCanvas(image));
  const figcaption = document.createElement('figcaption');
  figcaption.textContent = caption;
  tile.appendChild(figcaption);
  return tile;
}

function mipStrip(images: RGBAImage[], maxLevels?: number): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'mip-strip';
  images.slice(0, maxLevels ?? images.length).forEach((image, level) => {
    strip.appendChild(imageTile(image, `L${level} ${image.width}×${image.height}`));
  });
  return strip;
}

function cutoffPreview(image: RGBAImage, cutoff: number): HTMLCanvasElement {
  const preview = document.createElement('canvas');
  preview.width = image.width;
  preview.height = image.height;
  preview.className = 'pixel-canvas cutoff-preview';
  const output = new Uint8ClampedArray(image.data.length);
  for (let p = 0; p < image.width * image.height; p++) {
    const i = p * 4;
    if (image.data[i + 3] >= cutoff) {
      output[i] = image.data[i];
      output[i + 1] = image.data[i + 1];
      output[i + 2] = image.data[i + 2];
      output[i + 3] = 255;
    }
  }
  const ctx = preview.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.putImageData(new ImageData(output, image.width, image.height), 0, 0);
  preview.title = `alpha ≥ ${cutoff} 的裁切预览`;
  return preview;
}

export function renderAtlasPanel(root: HTMLElement): void {
  const result = runAtlasChecks();
  root.innerHTML = `
    <div class="atlas-checks" id="atlasChecks"></div>
    <div class="atlas-columns">
      <section class="atlas-block">
        <h4>128×64 相邻双色叶簇图集</h4>
        <p>左蓝、右橙两个 64×64 格，叶尖压到格边。安全链按各自 2×2 足迹降采样；单格采样最多用到全局 L6（2×1），不能使用会平均两格的 L7。</p>
        <div class="atlas-source-row">
          <figure class="checker-frame">
            <div id="atlasSource"></div>
            <figcaption>原图（放大显示，透明底为棋盘格）</figcaption>
          </figure>
        </div>
        <h5>安全 alpha 加权链</h5>
        <div id="safeAtlasStrip" class="checker-strip"></div>
      </section>

      <section class="atlas-block atlas-block--control">
        <h4>错误对照：非预乘 RGBA 直接平均</h4>
        <p>透明纹素里的脏 RGB 被一起平均，叶边会出现暗/品红圈。它只作为对照，不进入本页两条主链。</p>
        <h5>直接平均 mip</h5>
        <div id="naiveAtlasStrip" class="checker-strip"></div>
      </section>

      <section class="atlas-block atlas-block--fixture">
        <h4>可手算的 4×4 串色压力图</h4>
        <p>红格边缘、蓝格边缘和品红脏底。下列裁切预览使用 α≥60；L1 的 α≈64，刚好能检查 RGB。</p>
        <div class="fixture-row">
          <div><h5>原图</h5><div id="fixtureSource" class="checker-frame"></div></div>
          <div><h5>安全 L1 裁切后</h5><div id="fixtureSafe" class="checker-frame"></div></div>
          <div><h5>错误 L1 裁切后</h5><div id="fixtureNaive" class="checker-frame"></div></div>
        </div>
        <div id="fixtureRawStrips"></div>
      </section>
    </div>
  `;

  const checks = root.querySelector<HTMLElement>('#atlasChecks')!;
  checks.innerHTML = result.checks
    .map(
      (check) => `
      <div class="atlas-check ${check.pass ? 'is-pass' : 'is-fail'}">
        <strong>${check.pass ? '✓' : '×'} ${check.label}</strong>
        <span>${check.detail}</span>
      </div>`,
    )
    .join('');

  root.querySelector<HTMLElement>('#atlasSource')!.appendChild(imageCanvas(result.atlas));
  root.querySelector<HTMLElement>('#safeAtlasStrip')!.appendChild(mipStrip(result.safeAtlas, 7));
  root.querySelector<HTMLElement>('#naiveAtlasStrip')!.appendChild(mipStrip(result.naiveAtlas, 7));
  root.querySelector<HTMLElement>('#fixtureSource')!.appendChild(imageCanvas(result.fixture));
  root.querySelector<HTMLElement>('#fixtureSafe')!.appendChild(cutoffPreview(result.safeFixture[1], 60));
  root.querySelector<HTMLElement>('#fixtureNaive')!.appendChild(cutoffPreview(result.naiveFixture[1], 60));

  const rawStrips = root.querySelector<HTMLElement>('#fixtureRawStrips')!;
  rawStrips.appendChild(imageTile(result.safeFixture[1], '安全 L1 原始 RGBA'));
  rawStrips.appendChild(imageTile(result.naiveFixture[1], '错误 L1 原始 RGBA'));
  rawStrips.className = 'fixture-raw-row';
}
