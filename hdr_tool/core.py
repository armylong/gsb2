"""hdr_tool.core — 线性化、曝光合成、调色等核心算法(无 GUI 依赖, 可独立验证)。

约定:
  * 输入按已知 sRGB 响应解释(不恢复未知相机响应)。
  * EV(曝光档数)+1 表示该张照片曝光量翻倍(更亮), 因此线性辐射度 = 线性化值 / 2**EV。
  * 画布坐标: 第 i 张图像素 (x, y) 落在画布 (x + dx_i, y + dy_i)。
    参考图(第 0 张)位移通常为 (0, 0), 此时画布坐标即参考图像素坐标。
  * 合成只在所有照片位移后的有效重叠区内进行; 重叠区之外的数据一律不参与,
    边缘无效像素不会被当成黑色实景。
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

MAX_LONG_EDGE = 1600          # 输入长边上限
SHIFT_LIMIT = 20              # 单方向位移上限(像素)
MIN_IMAGES = 3
MAX_IMAGES = 5

# 截断判定阈值(0-255 编码值): 触及即认为该通道失去细节
CLIP_LO = 5
CLIP_HI = 250

# Rec.709/sRGB 亮度系数
LUMA = np.array([0.2126, 0.7152, 0.0722])


# ---------------------------------------------------------------- 色彩空间

def srgb_to_linear(u):
    """sRGB 编码值(0..1) → 线性光。"""
    u = np.asarray(u, dtype=np.float64)
    return np.where(u <= 0.04045, u / 12.92, ((u + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    """线性光 → sRGB 编码值(0..1)。负值截为 0, 不产生无效数值。"""
    c = np.clip(np.asarray(c, dtype=np.float64), 0.0, None)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def luminance(rgb):
    """线性 RGB 的相对亮度(Rec.709)。"""
    return (rgb[..., 0] * LUMA[0] + rgb[..., 1] * LUMA[1] + rgb[..., 2] * LUMA[2])


# ---------------------------------------------------------------- 输入

def load_image(path):
    """读取 PNG/JPEG → RGB uint8。拒绝带透明度、超限尺寸与不可读文件。"""
    data = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if data is None:
        raise ValueError(f"无法读取图片: {path}")
    if data.ndim == 3 and data.shape[2] == 4:
        raise ValueError(f"不支持带透明度的图片: {path}")
    if data.ndim == 2:
        data = cv2.cvtColor(data, cv2.COLOR_GRAY2BGR)
    h, w = data.shape[:2]
    if max(h, w) > MAX_LONG_EDGE:
        raise ValueError(f"长边 {max(h, w)} 超过 {MAX_LONG_EDGE} 像素: {path}")
    return data[:, :, ::-1].copy()  # BGR → RGB


def clipping_masks(img_u8):
    """返回 (暗部截断, 亮部截断) 布尔掩码: 任一通道触及阈值即视为失去细节。"""
    lo = np.any(img_u8 <= CLIP_LO, axis=2)
    hi = np.any(img_u8 >= CLIP_HI, axis=2)
    return lo, hi


# ---------------------------------------------------------------- 合成

def _tent_weight(z):
    """三角形权重, z 为 0..1 编码值; 截断处权重为 0, 中间调权重最大。"""
    w = np.minimum(z, 1.0 - z) * 4.0
    w[(z <= CLIP_LO / 255.0) | (z >= CLIP_HI / 255.0)] = 0.0
    return w


def overlap_rect(shifts, width, height):
    """所有照片位移后的有效重叠区 (x0, y0, x1, y1), 画布坐标。"""
    x0 = max(int(s[0]) for s in shifts)
    y0 = max(int(s[1]) for s in shifts)
    x1 = min(int(s[0]) + width for s in shifts)
    y1 = min(int(s[1]) + height for s in shifts)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("位移后不存在有效重叠区")
    return x0, y0, x1, y1


def merge_exposures(images, evs, shifts):
    """加权合成多曝光 → (hdr, valid, crop)。

    hdr   : (Hc, Wc, 3) float64, 线性相对亮度(相对参考曝光), 可查询。
    valid : (Hc, Wc) bool, False 表示整组照片在此都截断, 无法恢复(hdr 值为 0,
            调用方不得把它当作黑色实景)。
    crop  : 有效重叠区 (x0, y0, x1, y1), 画布坐标。
    """
    n = len(images)
    if not (MIN_IMAGES <= n <= MAX_IMAGES):
        raise ValueError(f"需要 {MIN_IMAGES}-{MAX_IMAGES} 张照片, 当前 {n} 张")
    h, w = images[0].shape[:2]
    for im in images:
        if im.shape[:2] != (h, w):
            raise ValueError("所有照片尺寸必须一致")
    x0, y0, x1, y1 = overlap_rect(shifts, w, h)
    num = np.zeros((y1 - y0, x1 - x0, 3))
    den = np.zeros((y1 - y0, x1 - x0, 3))
    for img, ev, (dx, dy) in zip(images, evs, shifts):
        crop = img[y0 - dy:y1 - dy, x0 - dx:x1 - dx].astype(np.float64) / 255.0
        lin = srgb_to_linear(crop) / (2.0 ** float(ev))
        wt = _tent_weight(crop)                      # 逐通道权重
        num += wt * lin
        den += wt
    hdr = np.where(den > 1e-12, num / np.maximum(den, 1e-12), 0.0)
    valid = np.all(den > 1e-12, axis=2)
    return hdr, valid, (x0, y0, x1, y1)


# ---------------------------------------------------------------- 调色

def tone_map(hdr, exposure=0.0, compression=0.5, saturation=1.0):
    """线性 HDR → sRGB 成品(0..1 float)。

    无状态: 每次都从 hdr 重新计算, 不会在已调过的结果上反复处理。
    亮度为零的像素保持为零; 极亮像素被压缩/截断到 1, 不产生 NaN/Inf。
    饱和度围绕亮度插值, 中性灰(无色度)不会被调成彩色。
    """
    gain = 2.0 ** float(exposure)
    lum = np.maximum(luminance(hdr), 0.0) * gain
    c = float(np.clip(compression, 0.0, 1.0))
    shoulder = lum / (1.0 + lum)                     # Reinhard 肩部, 极亮 → 1
    lum_out = (1.0 - c) * lum + c * shoulder
    scale = np.where(lum > 1e-12, lum_out / np.maximum(lum, 1e-12), 0.0)
    rgb = np.clip(hdr, 0.0, None) * scale[..., None]
    gray = luminance(rgb)[..., None]
    rgb = gray + (rgb - gray) * float(saturation)    # 中性灰 chroma=0, 不变
    rgb = np.clip(rgb, 0.0, 1.0)
    return linear_to_srgb(rgb)


# ---------------------------------------------------------------- 导出

def write_export(png_path, final_rgb_u8, meta):
    """写出 PNG(全分辨率当前结果)及同名 .json 参数文件。"""
    png_path = Path(png_path)
    if png_path.suffix.lower() != ".png":
        png_path = png_path.with_suffix(".png")
    cv2.imwrite(str(png_path), final_rgb_u8[:, :, ::-1])  # RGB → BGR
    png_path.with_suffix(".json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return png_path
