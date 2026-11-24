import numpy as np
import pytest

from chroma_inspector.color import yuv_to_rgb
from chroma_inspector.reconstruct import reconstruct_rgb
from chroma_inspector.formats import PIXEL_FORMATS, lookup_pixel_format, split_planes
from chroma_inspector.errors import UnsupportedPixelFormat


def test_neutral_gray_is_neutral_in_rgb_limited():
    y = np.full((4, 4), 128, np.float64)
    u = np.full((4, 4), 128, np.float64)
    v = np.full((4, 4), 128, np.float64)
    rgb = yuv_to_rgb(y, u, v, matrix="bt709", full_range=False)
    # R=G=B
    np.testing.assert_array_equal(rgb[..., 0], rgb[..., 1])
    np.testing.assert_array_equal(rgb[..., 1], rgb[..., 2])


def test_neutral_gray_full_range():
    y = np.full((4, 4), 80, np.float64)
    u = np.full((4, 4), 128, np.float64)
    v = np.full((4, 4), 128, np.float64)
    rgb = yuv_to_rgb(y, u, v, full_range=True)
    np.testing.assert_array_equal(rgb[..., 0], rgb[..., 1])
    # 全范围 Y=80 直接映射到 RGB≈80（允许 uint8 取整 ±1）
    assert abs(int(rgb[0, 0, 0]) - 80) <= 1


def test_reconstruct_neutral_any_site_identical():
    rng = np.random.default_rng(2)
    y = rng.integers(16, 235, size=(8, 8), dtype=np.uint8)
    u = np.full((4, 4), 128, np.uint8)
    v = np.full((4, 4), 128, np.uint8)
    pf = PIXEL_FORMATS["yuv420p"]
    from chroma_inspector.chroma import ChromaSite
    rgb_left = reconstruct_rgb(y, u, v, pf, ChromaSite.LEFT, "bt601", False)
    rgb_center = reconstruct_rgb(y, u, v, pf, ChromaSite.CENTER, "bt601", False)
    np.testing.assert_array_equal(rgb_left, rgb_center)
    # 每像素三通道相等
    np.testing.assert_array_equal(rgb_left[..., 0], rgb_left[..., 1])


def test_unsupported_pixel_format_rejected_with_reason():
    with pytest.raises(UnsupportedPixelFormat, match="高位深"):
        lookup_pixel_format("yuv420p10le")
    with pytest.raises(UnsupportedPixelFormat, match="RGB"):
        lookup_pixel_format("rgb24")


def test_split_planes_planar_and_semi():
    w, h = 4, 4
    pf = PIXEL_FORMATS["yuv420p"]
    y = np.arange(16, dtype=np.uint8).reshape(4, 4)
    u = np.full((2, 2), 10, np.uint8)
    v = np.full((2, 2), 20, np.uint8)
    frame = y.tobytes() + u.tobytes() + v.tobytes()
    yy, uu, vv = split_planes(pf, frame, w, h)
    np.testing.assert_array_equal(yy, y)
    np.testing.assert_array_equal(uu, u)
    np.testing.assert_array_equal(vv, v)

    # NV12: 交织 UV；NV21: 交织 VU
    nv12 = PIXEL_FORMATS["nv12"]
    inter = np.empty((2, 2, 2), np.uint8)
    inter[..., 0] = 10
    inter[..., 1] = 20
    raw = y.tobytes() + inter.tobytes()
    _, uu2, vv2 = split_planes(nv12, raw, w, h)
    assert (uu2 == 10).all() and (vv2 == 20).all()
    nv21 = PIXEL_FORMATS["nv21"]
    _, uu3, vv3 = split_planes(nv21, raw, w, h)
    assert (uu3 == 20).all() and (vv3 == 10).all()


def test_plane_sizes():
    pf = PIXEL_FORMATS["yuv420p"]
    y_size, c_size, frame = pf.plane_sizes(16, 16)
    assert (y_size, c_size, frame) == (256, 64, 384)
    pf2 = PIXEL_FORMATS["nv12"]
    _, c2, f2 = pf2.plane_sizes(16, 16)
    assert (c2, f2) == (128, 384)
    # 奇数尺寸向上取整
    cw, ch = pf.chroma_dims(15, 13)
    assert (cw, ch) == (8, 7)
