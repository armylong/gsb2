"""合成场景生成器：真值自洽、含亮度变化、错点和不相干图片。"""
from __future__ import annotations

import cv2
import numpy as np

from panorama import geometry as geo
from panorama.synthetic import build_synthetic_scene


def test_scene_contains_required_assets(tmp_path):
    meta = build_synthetic_scene(tmp_path / "s", n_frames=5)
    d = tmp_path / "s"
    assert (d / "world_groundtruth.png").exists()
    assert (d / "unrelated.png").exists()
    assert len(meta["frames"]) == 5
    for f in meta["frames"]:
        assert (d / f["file"]).exists()
        assert len(f["H_to_world"]) == 3


def test_groundtruth_homographies_are_consistent(tmp_path):
    meta = build_synthetic_scene(tmp_path / "s", n_frames=4)
    # 每张帧的四角经真值单应映射后必须落在世界坐标系内
    W, H = meta["world_size"]
    for f in meta["frames"]:
        Hm = np.array(f["H_to_world"])
        corners = geo.warp_corners(Hm, f["size"][0], f["size"][1])
        assert corners[:, 0].min() >= -5
        assert corners[:, 1].min() >= -5
        assert corners[:, 0].max() <= W + 5
        assert corners[:, 1].max() <= H + 5


def test_brightness_varies_across_frames(tmp_path):
    meta = build_synthetic_scene(tmp_path / "s", n_frames=5)
    brights = {f["file"]: f["brightness"] for f in meta["frames"]}
    assert len(set(round(v, 3) for v in brights.values())) > 1


def test_wrong_control_points_actually_differ(tmp_path):
    meta = build_synthetic_scene(tmp_path / "s", n_frames=4)
    pair = next(iter(meta["control_points_true"]))
    t = np.array(meta["control_points_true"][pair]["dst"])
    w = np.array(meta["control_points_wrong"][pair]["dst"])
    assert not np.allclose(t, w)
    # 至少前两个点被故意偏移
    assert np.linalg.norm(t[:2] - w[:2], axis=1).min() > 50


def test_unrelated_image_has_no_scene_content(tmp_path):
    meta = build_synthetic_scene(tmp_path / "s", n_frames=4)
    d = tmp_path / "s"
    world = cv2.imread(d / meta["world"])
    unrelated = cv2.imread(d / meta["unrelated"])
    # 不相干图与世界图的灰度直方图相关性应很低
    hw = cv2.calcHist([world], [0], None, [64], [0, 256])
    hu = cv2.calcHist([unrelated], [0], None, [64], [0, 256])
    corr = cv2.compareHist(hw, hu, cv2.HISTCMP_CORREL)
    assert corr < 0.5
