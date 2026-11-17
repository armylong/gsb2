"""基础抠像、边缘过渡、反光抑制、前景保护的单元测试。"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from greenscreen import MediaError, ProcessingError
from greenscreen.generate_test_assets import FPS, make_foreground_frame
from greenscreen.keying import (
    KeyingParams, compute_alpha, compute_background_score, despill,
    process_frame,
)
from greenscreen.media import probe_video


def _frame_with_ball():
    """取小球完整可见的一帧，并返回小球在画面中的中心。"""
    frame = make_foreground_frame(0)
    h, w = frame.shape[:2]
    cx = w // 2  # t=0 时人物在画面正中
    return frame, (cx + 30, h // 2 - 10 + 120)


def test_background_removed_and_foreground_kept(reader, background):
    frame = reader.read_frame(0)
    params = KeyingParams()
    alpha = compute_alpha(frame, params)

    h, w = alpha.shape
    # 四角是绿幕：alpha 应接近 0（被去除）
    corners = np.concatenate([
        alpha[0:8, 0:8].ravel(), alpha[0:8, w - 8:w].ravel(),
        alpha[h - 8:h, 0:8].ravel(), alpha[h - 8:h, w - 8:w].ravel(),
    ])
    assert corners.max() < 0.15

    # 人物身体中心是实心前景：alpha 应接近 1
    body = alpha[h // 2 + 120:h // 2 + 160, w // 2 - 30:w // 2 + 30]
    assert body.mean() > 0.9


def test_edge_params_change_alpha_band(reader):
    """调边缘参数必须显著改变半透明边缘带的宽度（边缘调整验证）。"""
    frame = reader.read_frame(12)

    hard = KeyingParams(edge_feather=0.0, edge_choke=0.0, smoothness=0.05)
    soft = KeyingParams(edge_feather=0.8, edge_choke=0.0, smoothness=0.6)

    a_hard = compute_alpha(frame, hard)
    a_soft = compute_alpha(frame, soft)

    band_hard = np.mean((a_hard > 0.05) & (a_hard < 0.95))
    band_soft = np.mean((a_soft > 0.05) & (a_soft < 0.95))
    assert band_soft > band_hard * 1.5

    # 收边应让前景面积变小
    choked = KeyingParams(edge_feather=0.0, edge_choke=0.8)
    a_choke = compute_alpha(frame, choked)
    assert (a_choke > 0.5).sum() < (a_hard > 0.5).sum()


def test_despill_reduces_green_excess(reader):
    """反光抑制后，有绿色溢出的像素绿色通道应明显下降（反光处理验证）。"""
    frame = reader.read_frame(0)
    params = KeyingParams()
    alpha = compute_alpha(frame, params)

    corrected = despill(frame, alpha, params)
    b, g, r = frame.astype(np.int16).transpose(2, 0, 1)
    b2, g2, r2 = corrected.astype(np.int16).transpose(2, 0, 1)

    spill_region = (g > np.maximum(b, r) + 15) & (alpha > 0.3)
    assert spill_region.sum() > 100  # 测试素材里确实存在反光区域
    delta = (g - g2)[spill_region]
    assert delta.mean() > 5.0
    # 红蓝通道不被改动，只动绿色通道
    np.testing.assert_array_equal(b, b2)
    np.testing.assert_array_equal(r, r2)


def test_protection_keeps_near_background_ball():
    """与背景同色但被前景包住的小球：开启保护应保留，关闭会被抠穿。"""
    frame, (bx, by) = _frame_with_ball()

    on = KeyingParams(protection_on=True, protection=1.0)
    off = KeyingParams(protection_on=False)

    alpha_on = compute_alpha(frame, on)
    alpha_off = compute_alpha(frame, off)

    patch_on = alpha_on[by - 8:by + 8, bx - 8:bx + 8]
    patch_off = alpha_off[by - 8:by + 8, bx - 8:bx + 8]
    assert patch_on.mean() > 0.7
    assert patch_off.mean() < 0.4
    assert patch_on.mean() - patch_off.mean() > 0.4


def test_shadow_protect_retains_hair(reader):
    """发丝（色相接近绿幕但更暗更灰）在开启暗部保护后应被更多保留，
    同时纯绿幕背景仍被干净去除。"""
    frame = reader.read_frame(0)
    h, w = frame.shape[:2]
    hair_region = (slice(45, 125), slice(w // 2 - 150, w // 2 + 150))

    on = compute_alpha(frame, KeyingParams(shadow_protect=1.0))
    off = compute_alpha(frame, KeyingParams(shadow_protect=0.0))

    assert on[hair_region].mean() > off[hair_region].mean() * 2
    # 发丝是稀疏线条、采样框内多为背景，0.25 已代表显著保留
    assert (on[hair_region] > 0.3).mean() > 0.25
    # 背景四角不能因为暗部保护而残留
    assert on[0:10, 0:10].max() < 0.15


def test_compare_mode_is_param_independent():
    """对比开关通过临时参数副本实现，正式参数不应被污染。"""
    params = KeyingParams(protection=True, despill_on=True)
    snapshot = params.to_dict()
    temp = KeyingParams.from_dict(params.to_dict())
    temp.protection_on = False
    temp.despill_on = False
    assert params.to_dict() == snapshot  # 原参数未变


def test_process_frame_returns_consistent_shapes(reader, background):
    frame = reader.read_frame(3)
    result = process_frame(frame, background, KeyingParams())
    for key in ("original", "foreground", "alpha", "composite"):
        assert result[key].shape[:2] == frame.shape[:2]
    # 背景图尺寸不同（800x450 vs 640x360），合成结果仍与前景同尺寸
    assert result["composite"].shape[1] == frame.shape[1]


def test_empty_frame_raises():
    empty = np.zeros((0, 0, 3), np.uint8)
    with pytest.raises(ProcessingError):
        process_frame(empty, np.zeros((4, 4, 3), np.uint8), KeyingParams())


def test_unsupported_and_missing_files(tmp_path):
    from greenscreen.media import ensure_supported, load_image, probe_video

    bad = tmp_path / "note.txt"
    bad.write_text("not a video", encoding="utf-8")
    with pytest.raises(MediaError):
        probe_video(bad)
    with pytest.raises(MediaError):
        load_image(bad)

    missing = tmp_path / "nope.mp4"
    with pytest.raises(MediaError):
        probe_video(missing)


def test_damaged_video_reported(tmp_path):
    fake = tmp_path / "broken.mp4"
    fake.write_bytes(b"\x00\x01\x02not a real video")
    with pytest.raises(MediaError):
        probe_video(fake)
