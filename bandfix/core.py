"""核心算法:镜头切分 + 条带内局部重建。

保证:任何情况下只改写 [y0, y1) 行带内的像素,带外逐字节保持源帧。
"""
from __future__ import annotations

import cv2
import numpy as np


# ---------------------------------------------------------------- 镜头检测

def detect_cuts(path: str, thresh: float = 0.15, scale: int = 64) -> list[int]:
    """返回切变帧号列表(每个值是新镜头的第一帧)。

    用缩略灰度图的帧间平均绝对差做突变检测,简单但对屏幕录像的硬切足够稳。
    """
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise IOError(f"无法打开视频: {path}")
    cuts: list[int] = []
    prev = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (scale, scale), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        if prev is not None:
            diff = float(np.mean(np.abs(gray - prev)))
            if diff > thresh:
                cuts.append(idx)
        prev = gray
        idx += 1
    cap.release()
    return cuts


def shot_of(frame_idx: int, cuts: list[int]) -> tuple[int, int]:
    """给定帧号,返回所属镜头的 [start, end) 帧区间(end 为下一个切点或 inf)。"""
    start = 0
    end = 1 << 30
    for c in cuts:
        if c <= frame_idx:
            start = c
        else:
            end = c
            break
    return start, end


# ---------------------------------------------------------------- 重建方法

def _clip_band(y0: int, y1: int, h: int) -> tuple[int, int]:
    y0 = max(0, min(y0, h - 1))
    y1 = max(y0 + 1, min(y1, h))
    return y0, y1


def repair_spatial(frame: np.ndarray, y0: int, y1: int, strength: float) -> np.ndarray:
    """方案A · 空间重建:用条带上下边缘行做垂直线性插值,再轻模糊去台阶。

    只依赖当前帧,任何镜头位置都可用。
    """
    h = frame.shape[0]
    y0, y1 = _clip_band(y0, y1, h)
    out = frame.copy()
    top = frame[max(0, y0 - 1)].astype(np.float32)
    bot = frame[min(h - 1, y1)].astype(np.float32)
    n = y1 - y0
    recon = np.empty((n, frame.shape[1], 3), np.float32)
    for i in range(n):
        t = (i + 1) / (n + 1)
        recon[i] = (1.0 - t) * top + t * bot
    recon = cv2.GaussianBlur(recon, (0, 0), sigmaX=1.2, sigmaY=0.8)
    orig = frame[y0:y1].astype(np.float32)
    out[y0:y1] = np.clip(orig * (1.0 - strength) + recon * strength, 0, 255).astype(np.uint8)
    return out


def repair_temporal(frames: list[np.ndarray | None], y0: int, y1: int,
                    strength: float) -> np.ndarray:
    """方案B · 时域重建:取同镜头内邻近帧的条带中位数重建当前帧条带。

    frames: 以当前帧为中心的上下文列表(中间为当前帧,None 表示该位置
    已越出镜头边界、不可用)。调用方负责保证不跨镜头。
    若同镜头内没有任何邻近帧,退化为空间方案。
    """
    cur = frames[len(frames) // 2]
    h = cur.shape[0]
    y0, y1 = _clip_band(y0, y1, h)
    neigh = [f[y0:y1].astype(np.float32) for i, f in enumerate(frames)
             if f is not None and i != len(frames) // 2]
    if not neigh:
        return repair_spatial(cur, y0, y1, strength)
    recon = np.median(np.stack(neigh), axis=0)
    recon = cv2.GaussianBlur(recon, (0, 0), sigmaX=0.8, sigmaY=0.6)
    out = cur.copy()
    orig = cur[y0:y1].astype(np.float32)
    out[y0:y1] = np.clip(orig * (1.0 - strength) + recon * strength, 0, 255).astype(np.uint8)
    return out


def repair_frame(get_frame, idx: int, y0: int, y1: int, *,
                 method: str, strength: float, radius: int,
                 cuts: list[int]) -> np.ndarray:
    """单帧修复入口。

    get_frame(i) -> BGR 帧;method: 'spatial' | 'temporal'。
    时域方法的上下文严格限制在当前镜头 [start, end) 内。
    """
    if method == "spatial":
        return repair_spatial(get_frame(idx), y0, y1, strength)
    start, end = shot_of(idx, cuts)
    ctx: list[np.ndarray | None] = []
    for k in range(idx - radius, idx + radius + 1):
        if k < start or k >= end:
            ctx.append(None)
        else:
            ctx.append(get_frame(k))
    return repair_temporal(ctx, y0, y1, strength)
