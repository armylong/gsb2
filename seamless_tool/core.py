"""核心图像处理:接缝混合、循环偏移、边界指标、保护区。

所有函数只依赖 numpy,不依赖 GUI,便于单元测试。

坐标约定:图像为 HxWx3 的 uint8 RGB 数组。
- "水平接缝"(horizontal seam)指上下边界(y 方向环绕)之间的接缝,
  即平铺时一块的下边与下一块的上边相接处。
- "垂直接缝"(vertical seam)指左右边界(x 方向环绕)之间的接缝。
"""
from __future__ import annotations

import numpy as np

MIN_SIZE = 128
MAX_SIZE = 1024


class ImageValidationError(ValueError):
    """输入图片不符合要求。"""


def validate_image(img: np.ndarray) -> np.ndarray:
    """校验输入为 128..1024 的 RGB 图像,返回 contiguous uint8 数组。"""
    if img is None:
        raise ImageValidationError("无法读取图片")
    if img.ndim == 2:
        img = np.stack([img] * 3, axis=-1)
    if img.ndim != 3 or img.shape[2] < 3:
        raise ImageValidationError("只支持普通不透明彩色/灰度图片")
    img = img[:, :, :3]
    h, w = img.shape[:2]
    if not (MIN_SIZE <= w <= MAX_SIZE and MIN_SIZE <= h <= MAX_SIZE):
        raise ImageValidationError(
            f"图片宽高需各自在 {MIN_SIZE}..{MAX_SIZE} 像素之间,当前为 {w}x{h}"
        )
    return np.ascontiguousarray(img.astype(np.uint8))


def roll_image(img: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """循环偏移(环绕移动):不丢内容、不补黑边。"""
    return np.roll(np.roll(img, dy, axis=0), dx, axis=1)


def _smooth_weights(width: int) -> np.ndarray:
    """过渡带权重:边缘像素(d=0)恰为 0.5,随距离 smoothstep 衰减趋近 0。"""
    d = np.arange(width, dtype=np.float64)
    t = np.clip(1.0 - d / width, 0.0, 1.0)
    return 0.5 * t * t * (3.0 - 2.0 * t)


def _blend_axis_float(work: np.ndarray, axis: int, width: int) -> np.ndarray:
    """沿 axis 的环绕接缝做对称过渡带交叉混合(float 空间)。

    对距边缘 d 的像素 p_lo(下标 d)与对侧对称像素 p_hi(下标 n-1-d):
        new_lo = (1-a)*p_lo + a*p_hi
        new_hi = (1-a)*p_hi + a*p_lo
    边缘处 a=0.5,两侧取同一均值,因此边界两侧严格相等;
    a 随距离平滑衰减到 0,带外像素不受影响。
    只改动过渡带内的像素,不是整图镜像,也不是同色线覆盖。
    """
    n = work.shape[axis]
    width = int(min(width, n // 2))
    if width <= 0:
        return work
    a = _smooth_weights(width)
    shape = [1, 1, 1]
    shape[axis] = width
    aa = a.reshape(shape)
    idx = np.arange(width)
    lo = np.take(work, idx, axis=axis)
    hi = np.take(work, n - 1 - idx, axis=axis)
    new_lo = (1.0 - aa) * lo + aa * hi
    new_hi = (1.0 - aa) * hi + aa * lo
    out = work.copy()
    sl = [slice(None)] * 3
    sl[axis] = idx
    out[tuple(sl)] = new_lo
    sl[axis] = n - 1 - idx
    out[tuple(sl)] = new_hi
    return out


def band_mask(shape, h_on: bool, h_w: int, v_on: bool, v_w: int) -> np.ndarray:
    """接缝处理会触及的过渡带区域(bool 掩码)。"""
    h, w = shape[:2]
    m = np.zeros((h, w), dtype=bool)
    if h_on:
        t = int(min(h_w, h // 2))
        m[:t, :] = True
        m[h - t:, :] = True
    if v_on:
        t = int(min(v_w, w // 2))
        m[:, :t] = True
        m[:, w - t:] = True
    return m


def make_seamless(img: np.ndarray, mask: np.ndarray | None = None,
                  h_on: bool = True, h_w: int = 16,
                  v_on: bool = True, v_w: int = 16) -> np.ndarray:
    """生成无缝化单块。

    双向都开启时先水平后垂直:垂直混合作用于已被水平混合的角区,
    因此四角交汇处同样连续。mask 为 True 的像素(保护区)在处理后
    精确还原为原图值。
    """
    work = img.astype(np.float64)
    if h_on:
        work = _blend_axis_float(work, 0, h_w)
    if v_on:
        work = _blend_axis_float(work, 1, v_w)
    out = np.rint(work).clip(0, 255).astype(np.uint8)
    if mask is not None and mask.any():
        out[mask] = img[mask]
    return out


def conflict_mask(mask: np.ndarray, h_on: bool, h_w: int,
                  v_on: bool, v_w: int) -> np.ndarray:
    """保护区与过渡带的交集:这些位置无法同时保证保护与无缝。"""
    if mask is None:
        return None
    return mask & band_mask(mask.shape, h_on, h_w, v_on, v_w)


def _axis_metrics(f: np.ndarray, axis: int) -> dict:
    """沿 axis 环绕边界的颜色差与梯度突变统计(每像素取 RGB 均值绝对值)。"""
    first = np.take(f, 0, axis=axis)
    last = np.take(f, f.shape[axis] - 1, axis=axis)
    second = np.take(f, 1, axis=axis)
    color = np.abs(first - last).mean(axis=-1)
    # 边界处二阶差分:跨边界的梯度 (first-last) 与内部梯度 (second-first) 之差
    jump = np.abs(second - 2.0 * first + last).mean(axis=-1)
    # 内部二阶差分作为参考基线
    interior = f.copy()
    ip1 = np.roll(interior, -1, axis=axis)
    im1 = np.roll(interior, 1, axis=axis)
    second_diff = np.abs(ip1 - 2.0 * interior + im1).mean(axis=-1)
    # 排除边界本身的两处,只统计内部
    idx = np.arange(1, f.shape[axis] - 1)
    inner = np.take(second_diff, idx, axis=axis)
    return {
        "color_mean": float(color.mean()),
        "color_max": float(color.max()),
        "grad_mean": float(jump.mean()),
        "grad_max": float(jump.max()),
        "interior_grad_mean": float(inner.mean()),
    }


def boundary_metrics(img: np.ndarray) -> dict:
    """返回 {'h': ..., 'v': ...} 两组边界指标。

    h: 水平接缝(上下边界);v: 垂直接缝(左右边界)。
    color_*: 边界两侧颜色差;grad_*: 边界处梯度突变(二阶差分);
    interior_grad_mean: 内部梯度突变均值,作为该图自身的参考水平。
    """
    f = img.astype(np.float64)
    return {"h": _axis_metrics(f, 0), "v": _axis_metrics(f, 1)}


def tile3(img: np.ndarray) -> np.ndarray:
    """整体合成 3x3 平铺图(一次性合成,避免逐块缩放产生假缝)。"""
    return np.tile(img, (3, 3, 1))
