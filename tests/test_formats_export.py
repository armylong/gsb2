"""覆盖白名单内其余像素格式的端到端重建，以及导出画布几何。"""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest

from chroma_inspector.chroma import ChromaSite
from chroma_inspector.export import assemble_side_by_side
from chroma_inspector.formats import PIXEL_FORMATS, split_planes
from chroma_inspector.reconstruct import reconstruct_rgb


def _frame_for(pf_name: str, w: int, h: int):
    pf = PIXEL_FORMATS[pf_name]
    cw, ch = pf.chroma_dims(w, h)
    rng = np.random.default_rng(7)
    y = rng.integers(20, 235, size=(h, w), dtype=np.uint8)
    if pf.layout == "planar":
        u = rng.integers(60, 200, size=(ch, cw), dtype=np.uint8)
        v = rng.integers(60, 200, size=(ch, cw), dtype=np.uint8)
        raw = y.tobytes() + u.tobytes() + v.tobytes()
    else:
        inter = np.empty((ch, cw, 2), np.uint8)
        inter[..., 0] = rng.integers(60, 200, size=(ch, cw), dtype=np.uint8)
        inter[..., 1] = rng.integers(60, 200, size=(ch, cw), dtype=np.uint8)
        u = inter[..., 0].copy()
        v = inter[..., 1].copy()
        raw = y.tobytes() + inter.tobytes()
    return pf, *split_planes(pf, raw, w, h)


@pytest.mark.parametrize(
    "pf_name,w,h,site",
    [
        ("yuv420p", 16, 16, ChromaSite.CENTER),
        ("yuvj420p", 16, 16, ChromaSite.LEFT),
        ("yuv422p", 16, 8, ChromaSite.CENTER),
        ("yuvj422p", 16, 8, ChromaSite.LEFT),
        ("yuv444p", 8, 8, ChromaSite.LEFT),
        ("yuvj444p", 8, 8, ChromaSite.LEFT),
        ("nv12", 16, 16, ChromaSite.TOP),
        ("nv21", 16, 16, ChromaSite.CENTER),
    ],
)
def test_all_whitelisted_formats_reconstruct(pf_name, w, h, site):
    pf, y, u, v = _frame_for(pf_name, w, h)
    rgb = reconstruct_rgb(y, u, v, pf, site, "bt601", pf.full_range)
    assert rgb.shape == (h, w, 3)
    assert rgb.dtype == np.uint8
    assert rgb.min() >= 0 and rgb.max() <= 255


def test_422_horizontal_phase_only():
    pf, y, u, v = _frame_for("yuv422p", 16, 8)
    u.fill(128)
    v.fill(128)
    u[:, 4:] = 200  # 色度面 8x8，边沿在色度列 3/4 之间
    rgb_l = reconstruct_rgb(y, u, v, pf, ChromaSite.LEFT, "bt601", False)
    rgb_c = reconstruct_rgb(y, u, v, pf, ChromaSite.CENTER, "bt601", False)
    assert not np.array_equal(rgb_l, rgb_c)


def test_444_site_is_irrelevant():
    pf, y, u, v = _frame_for("yuv444p", 8, 8)
    r1 = reconstruct_rgb(y, u, v, pf, ChromaSite.LEFT, "bt601", False)
    r2 = reconstruct_rgb(y, u, v, pf, ChromaSite.CENTER, "bt601", False)
    np.testing.assert_array_equal(r1, r2)


def test_assemble_canvas_geometry():
    a = np.zeros((10, 12, 3), np.uint8)
    b = np.ones((10, 12, 3), np.uint8) * 255
    canvas, geo = assemble_side_by_side(a, b, "A", "B", "frame 2")
    # B 面板原点必须在 A 面板右边（修复标签错位的回归保护）
    assert geo["bx"] > geo["ax"] + 12
    assert geo["label_b"][0] == geo["bx"]
    # 画布高度容纳标注带 + 面板 + 边距
    assert canvas.shape[0] == geo["top"] + 10 + 12
    # 两块面板内容确实不同且落在各自区域
    top = geo["top"]
    assert canvas[top + 5, geo["ax"] + 5].tolist() == [0, 0, 0]
    assert canvas[top + 5, geo["bx"] + 5].tolist() == [255, 255, 255]


def test_assemble_zoom_crop():
    rgb = np.arange(10 * 10 * 3, dtype=np.uint8).reshape(10, 10, 3)
    canvas, geo = assemble_side_by_side(
        rgb, rgb, "A", "B", "f", zoom_crop=(2, 2, 4, 4)
    )
    # 2x2 区域 ×4 最近邻 -> 面板 8x8
    assert geo["panel_w"] == 8 and geo["panel_h"] == 8
