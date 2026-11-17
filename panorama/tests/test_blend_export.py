"""融合、鬼影提示、有效区域、裁剪有效性与黑色实景保留。"""
from __future__ import annotations

import numpy as np
import pytest

from panorama import blend
from panorama.config import Config


def test_full_canvas_keeps_transparent_border(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    full = blend.export_full_canvas(rep.canvas, eng.cfg)
    assert full.ndim == 3 and full.shape[2] == 4
    # 完整画布必然存在透明边界（不规则全景外接矩形）
    assert (full[..., 3] == 0).sum() > 0
    # 有效像素 alpha 必须为 255
    assert set(np.unique(full[..., 3])).issubset({0, 255})


def test_valid_crop_has_no_holes(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    crop, (x, y, w, h) = blend.export_valid_crop(rep.canvas, eng.cfg)
    assert w > 0 and h > 0
    assert (crop[..., 3] == 0).sum() == 0
    # 与预览一致：裁剪区就是画布对应子矩阵
    sub = rep.canvas.canvas[y: y + h, x: x + w]
    assert np.array_equal(crop, sub)
    # 双保险：mask 在该矩形内全有效
    assert rep.canvas.valid_mask[y: y + h, x: x + w].min() == 255


def test_largest_valid_rectangle_full_mask():
    mask = np.full((100, 120), 255, np.uint8)
    x, y, w, h = blend.largest_valid_rectangle(mask)
    assert (w, h) == (120, 100)


def test_largest_valid_rectangle_avoids_hole():
    mask = np.full((100, 100), 255, np.uint8)
    mask[40:60, 40:60] = 0  # 中心空洞
    x, y, w, h = blend.largest_valid_rectangle(mask)
    sub = mask[y: y + h, x: x + w]
    assert (sub == 0).sum() == 0  # 矩形内绝不含空洞


def test_black_real_content_preserved(engine_with_scene):
    """纯黑实景不能因亮度为 0 被当作无效背景删除。"""
    eng = engine_with_scene
    rep = eng.rebuild()
    crop, _ = blend.export_valid_crop(rep.canvas, eng.cfg)
    black_valid = np.sum(
        (crop[..., :3].sum(axis=2) == 0) & (crop[..., 3] == 255)
    )
    assert black_valid > 1000  # 场景含明确黑色实景块


def test_export_size_guard(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    cfg = Config()
    cfg.max_export_side = 10  # 故意收紧上限
    with pytest.raises(blend.CanvasTooLargeError):
        blend.export_full_canvas(rep.canvas, cfg)


def test_overlay_and_blend_both_valid(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    c = rep.canvas
    assert c.canvas.shape == c.overlay.shape
    assert c.canvas.shape[:2] == c.valid_mask.shape
    # 融合与叠加的有效区域一致
    assert np.array_equal(
        (c.canvas[..., 3] > 0), (c.overlay[..., 3] > 0)
    )


def test_gain_compensation_reduces_brightness_gap():
    """增益补偿应缩小重叠区亮度差。"""
    rng = np.random.default_rng(3)
    base = rng.integers(40, 200, (200, 200, 3)).astype(np.uint8)
    dark = (base.astype(np.float32) * 0.6).astype(np.uint8)
    bright = (base.astype(np.float32) * 1.3).clip(0, 255).astype(np.uint8)
    mask = np.ones((200, 200), np.uint8)
    gains = blend._gain_compensation([dark, bright], [mask, mask])
    # 补偿后两者均值应比补偿前更接近
    before = abs(dark.mean() - bright.mean())
    after = abs(
        np.clip(dark.astype(np.float32) * gains[0], 0, 255).mean()
        - np.clip(bright.astype(np.float32) * gains[1], 0, 255).mean()
    )
    assert after < before
