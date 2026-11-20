"""演示素材验证：尺寸合规、独立标记颜色唯一且可定位。"""

import numpy as np

from content_aware import demos
from content_aware.io import SIDE_MIN, SIDE_MAX


def test_demo_scene_dimensions_in_import_range():
    image, markers = demos.make_demo_scene()
    h, w = image.shape[:2]
    assert SIDE_MIN <= w <= SIDE_MAX and SIDE_MIN <= h <= SIDE_MAX
    assert image.dtype == np.uint8 and image.shape[2] == 3


def test_marker_colors_are_unique_and_present_in_image():
    image, markers = demos.make_demo_scene()
    colors = [m[3] for m in markers]
    assert len(set(colors)) == len(colors)          # 独立可辨认
    for x, y, size, bgr in markers:
        center = image[y + size // 2, x + size // 2]
        assert tuple(int(v) for v in center) == bgr


def test_blocked_mask_covers_full_width_every_row():
    h, w = 300, 500
    blocked = demos.make_blocked_mask(h, w)
    band = blocked[np.where(blocked.any(axis=1))[0]]
    assert band.shape[0] > 0 and band.all(axis=1).all()   # 每行都全宽保护


def test_partial_band_does_not_cover_full_width():
    h, w = 300, 500
    partial = demos.make_partial_band_mask(h, w)
    assert partial.any() and not partial.all(axis=1).any()
