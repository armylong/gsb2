"""量化结果分析：每级像素数、色带边界、误差图与扫描线剖面。"""
from __future__ import annotations

import numpy as np


def level_histogram(qgray: np.ndarray, alpha: np.ndarray,
                    levels: np.ndarray) -> np.ndarray:
    """统计每个灰阶的像素数（完全透明像素不计入任何一级）。"""
    opaque = alpha > 0
    counts = np.zeros(levels.size, dtype=np.int64)
    if not opaque.any():
        return counts
    vals = qgray[opaque]
    # 以量化值与级别的精确匹配来归类（量化输出一定来自 levels）
    flat_levels = levels.reshape(1, -1)
    matches = np.abs(vals[:, None] - flat_levels) < 1e-9
    idx = np.argmax(matches, axis=1)
    np.add.at(counts, idx, 1)
    return counts


def boundary_mask(qgray: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """色带边界：与四邻量化值不同的不透明像素（边界两侧各自标 True）。

    透明像素及其邻接边不产生边界，从而透明区轮廓不会被误报成色带。
    """
    opaque = alpha > 0
    border = np.zeros_like(qgray, dtype=bool)
    if qgray.shape[0] > 1:
        diff_v = (qgray[1:, :] != qgray[:-1, :])
        both_v = opaque[1:, :] & opaque[:-1, :]
        edge_v = diff_v & both_v
        border[1:, :] |= edge_v
        border[:-1, :] |= edge_v
    if qgray.shape[1] > 1:
        diff_h = (qgray[:, 1:] != qgray[:, :-1])
        both_h = opaque[:, 1:] & opaque[:, :-1]
        edge_h = diff_h & both_h
        border[:, 1:] |= edge_h
        border[:, :-1] |= edge_h
    return border


def boundary_transitions(qgray: np.ndarray, alpha: np.ndarray,
                         levels: np.ndarray, axis: int = 1,
                         max_rows: int | None = None) -> list[dict]:
    """沿指定方向（axis=1 水平扫描）列出每条扫描线上的色带跳变位置。

    返回 [{row, x(或y), from_level, to_level, from_value, to_value}, ...]，
    用于界面中“色带边界”列表；max_rows 限制扫描行数避免界面过大。
    """
    opaque = alpha > 0
    h, w = qgray.shape
    level_to_idx = {round(float(v), 9): i for i, v in enumerate(levels)}
    out: list[dict] = []
    if axis == 1:
        rows = range(h) if max_rows is None else range(0, h, max(1, h // max_rows))
        for y in rows:
            prev = None
            for x in range(w):
                if not opaque[y, x]:
                    prev = None
                    continue
                cur = float(qgray[y, x])
                if prev is not None and cur != prev[1]:
                    out.append({
                        "row": y,
                        "pos": x,
                        "from_idx": level_to_idx[round(prev[1], 9)],
                        "to_idx": level_to_idx[round(cur, 9)],
                        "from_value": prev[1],
                        "to_value": cur,
                    })
                prev = (x, cur)
    else:
        cols = range(w) if max_rows is None else range(0, w, max(1, w // max_rows))
        for x in cols:
            prev = None
            for y in range(h):
                if not opaque[y, x]:
                    prev = None
                    continue
                cur = float(qgray[y, x])
                if prev is not None and cur != prev[1]:
                    out.append({
                        "col": x,
                        "pos": y,
                        "from_idx": level_to_idx[round(prev[1], 9)],
                        "to_idx": level_to_idx[round(cur, 9)],
                        "from_value": prev[1],
                        "to_value": cur,
                    })
                prev = (y, cur)
    return out


def error_map(gray: np.ndarray, qgray: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """有符号误差图：量化值 - 原连续值，透明处置 0。"""
    err = qgray - gray
    return np.where(alpha > 0, err, 0.0)


def error_stats(err: np.ndarray, alpha: np.ndarray) -> dict:
    """误差统计（只统计不透明像素）。"""
    opaque = alpha > 0
    vals = err[opaque]
    if vals.size == 0:
        return {"count": 0, "mae": 0.0, "rmse": 0.0, "max": 0.0, "min": 0.0, "mean": 0.0}
    return {
        "count": int(vals.size),
        "mae": float(np.mean(np.abs(vals))),
        "rmse": float(np.sqrt(np.mean(vals ** 2))),
        "max": float(np.max(vals)),
        "min": float(np.min(vals)),
        "mean": float(np.mean(vals)),
    }


def scanline(gray: np.ndarray, qgray: np.ndarray, alpha: np.ndarray,
             y: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """取第 y 行的原图值、量化值、透明度剖面（局部放大联动用）。"""
    h = gray.shape[0]
    y = int(np.clip(y, 0, h - 1))
    return gray[y, :].copy(), qgray[y, :].copy(), alpha[y, :].copy()


def error_to_rgb(err: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """把有符号误差渲染为 RGB：正向红、负向蓝、零为白，幅度按最大绝对误差归一。"""
    opaque = alpha > 0
    scale = float(np.max(np.abs(err[opaque]))) if opaque.any() else 0.0
    norm = np.divide(err, scale, out=np.zeros_like(err), where=scale > 0)
    norm = np.clip(norm, -1.0, 1.0)
    rgb = np.ones((*err.shape, 3), dtype=np.float64)
    pos = norm > 0
    neg = norm < 0
    # 正误差：白 -> 红
    rgb[pos] = np.stack([np.ones_like(norm[pos]), 1 - norm[pos], 1 - norm[pos]], axis=-1)
    # 负误差：白 -> 蓝
    rgb[neg] = np.stack([1 + norm[neg], 1 + norm[neg], np.ones_like(norm[neg])], axis=-1)
    rgb[~opaque] = 0.0
    return rgb
