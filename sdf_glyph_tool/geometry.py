"""程序生成的几何字形轮廓。

所有字形在 100x100 的 em 坐标系中定义, y 轴向上, 基线可视为 y=0。
每个字形是若干条闭合折线 (contour); 孔洞就是完全位于外轮廓内部的独立闭合折线,
内外关系由 even-odd(奇偶)规则判定, 因此折线环绕方向不影响结果。

圆弧用足够多的线段逼近 (每段弦高误差 < 0.002 em 单位), 作为"高精度参考轮廓"。
"""
from __future__ import annotations

import numpy as np

GLYPH_EM = 100.0  # 字形 em 方框边长


def arc(cx: float, cy: float, r: float, a0: float, a1: float, n: int) -> np.ndarray:
    """圆弧采样为折线, 角度单位弧度, 逆时针。返回 (n, 2) 点列。"""
    t = np.linspace(a0, a1, n)
    return np.column_stack([cx + r * np.cos(t), cy + r * np.sin(t)])


def _rot(p: np.ndarray, deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.column_stack([p[:, 0] * c - p[:, 1] * s, p[:, 0] * s + p[:, 1] * c])


class Glyph:
    def __init__(self, name: str, desc: str, contours: list[np.ndarray]):
        self.name = name
        self.desc = desc
        # 每条 contour: (M, 2) float64, 闭合折线(末点不必重复首点), em 坐标, y 向上
        self.contours = [np.asarray(c, dtype=np.float64) for c in contours]


def _rect(x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)


def _glyph_rect_hole() -> Glyph:
    outer = _rect(15, 15, 85, 85)
    hole = _rect(38, 38, 62, 62)
    return Glyph("方框带孔", "直角外框 + 矩形内孔(孔洞按字形外部处理)", [outer, hole])


def _glyph_wedge_slit() -> Glyph:
    # 平行四边形, 四条边均为斜线
    outer = np.array([[15, 15], [85, 30], [70, 85], [10, 65]], dtype=np.float64)
    # 窄缝: 长 44、宽 1.5 em 单位的细长四边形孔, 旋转 25 度
    cx, cy, ln, wd = 46.0, 50.0, 44.0, 1.5
    slit = np.array([[-ln / 2, -wd / 2], [ln / 2, -wd / 2],
                     [ln / 2, wd / 2], [-ln / 2, wd / 2]])
    slit = _rot(slit, 25.0) + np.array([cx, cy])
    return Glyph("斜边窄缝", "斜线外轮廓 + 1.5 单位宽斜置窄缝(低源分辨率下会消失)",
                 [outer, slit])


def _glyph_ring_c() -> Glyph:
    # C 形圆环: 外半径 44、内半径 27, 开口窄缝半角 a0, 缝隙在 +x 方向
    cx, cy, r_out, r_in = 50.0, 50.0, 44.0, 27.0
    a0 = 0.028  # 缝隙在内半径处宽约 2*27*sin(a0) ≈ 1.5 em 单位
    n = 200
    outer = arc(cx, cy, r_out, a0, 2 * np.pi - a0, n)
    inner = arc(cx, cy, r_in, 2 * np.pi - a0, a0, n)  # 反向走回
    contour = np.vstack([outer, inner])  # 单条轮廓: 外弧 -> 内弧, 缝隙自然形成
    return Glyph("圆弧C环", "圆弧外/内轮廓 + 约 1.5 单位宽开口窄缝(孔洞与缝隙)",
                 [contour])


def _glyph_combo() -> Glyph:
    # 拱门形: 矩形墙身 + 半圆拱顶(直角 + 圆弧), 三角形窗孔(斜线) + 细长竖缝
    body = [np.array([[20, 10], [80, 10], [80, 55]], dtype=np.float64)]
    arch = arc(50.0, 55.0, 30.0, 0.0, np.pi, 120)
    body_outline = np.vstack([body[0], arch, np.array([[20, 55]], dtype=np.float64)])
    tri_hole = np.array([[35, 20], [65, 20], [50, 45]], dtype=np.float64)
    slit = _rect(49.25, 58, 50.75, 84)  # 宽 1.5 的竖直窄缝
    return Glyph("拱门窗(综合)", "直角 + 圆弧拱顶 + 斜边三角孔 + 1.5 单位窄竖缝",
                 [body_outline, tri_hole, slit])


GLYPHS: list[Glyph] = [
    _glyph_rect_hole(),
    _glyph_wedge_slit(),
    _glyph_ring_c(),
    _glyph_combo(),
]


def get_glyph(name: str) -> Glyph:
    for g in GLYPHS:
        if g.name == name:
            return g
    raise KeyError(name)
