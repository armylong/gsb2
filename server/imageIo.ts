/**
 * 图片读写(sharp)。服务端接口与自动验证脚本共用本模块,
 * 保证"导出文件重新载入"与预览/导出走完全相同的编解码路径。
 *
 * 解码约定:输出固定为 RGBA 四通道 8bit;内嵌 ICC 的图片转换到 sRGB,
 * 之后所有处理都把数值当作 sRGB 编码值解释。
 */

import sharp from 'sharp';

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export async function decodeImage(input: Buffer | Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(input)
    .toColorspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`解码结果通道数异常: ${info.channels}(期望 4)`);
  }
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

export async function encodePng(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Buffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`非法尺寸: ${width}×${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new Error(`像素数据长度 ${data.length} 与尺寸 ${width}×${height}×4 不符`);
  }
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}
