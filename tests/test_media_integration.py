"""ffmpeg/ffprobe 集成测试：真实生成短片再走完整打开/重建流程。"""
import os

import numpy as np
import pytest

from chroma_inspector.chroma import ChromaSite
from chroma_inspector.errors import RawParamError, UnsupportedPixelFormat
from chroma_inspector.media import (
    infer_raw_or_raise,
    open_media,
    open_raw,
    parse_raw_filename,
)
from chroma_inspector.patterns import FRAMES, H, W, generate_all
from chroma_inspector.reconstruct import reconstruct_rgb

pytestmark = pytest.mark.skipif(
    os.system("ffmpeg -version >/dev/null 2>&1") != 0,
    reason="未安装 ffmpeg",
)


@pytest.fixture(scope="module")
def clip_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("clips")
    files = generate_all(str(d))
    return d, files


def test_patterns_generated(clip_dir):
    d, files = clip_dir
    names = sorted(os.path.basename(f) for f in files)
    assert "pat_horizontal.mkv" in names
    assert "pat_neutral.yuv" in names
    assert len(files) == len(set(files))


def test_declared_chroma_location_read_back(clip_dir):
    d, _ = clip_dir
    m = open_media(os.path.join(d, "pat_horizontal.mkv"))
    assert m.pixel_format.name == "yuv420p"
    assert m.declared_site == ChromaSite.LEFT
    assert m.frame_count == FRAMES
    assert (m.width, m.height) == (W, H)

    m_center = open_media(os.path.join(d, "pat_fine_lines.mkv"))
    assert m_center.declared_site == ChromaSite.CENTER

    m_top = open_media(os.path.join(d, "pat_vertical.mkv"))
    assert m_top.declared_site == ChromaSite.TOP


def test_unspecified_declaration_shows_reason(clip_dir):
    d, _ = clip_dir
    m = open_media(os.path.join(d, "pat_neutral.mkv"))
    assert m.declared_site is None
    assert "未声明" in m.declaration_note


def test_raw_yuv_has_no_declaration(clip_dir):
    d, _ = clip_dir
    path = os.path.join(d, "pat_neutral.yuv")
    m = open_raw(path, W, H, "yuv420p")
    assert m.is_raw
    assert m.declared_site is None
    assert "无容器" in m.declaration_note
    assert m.frame_count == FRAMES
    y, u, v = m.read_frame_planes(0)
    assert y.shape == (H, W) and u.shape == (H // 2, W // 2)


def test_raw_filename_inference():
    p = "/tmp/clip_1920x1080_yuv420p.yuv"
    assert parse_raw_filename(p) == (1920, 1080, "yuv420p")
    assert parse_raw_filename("/tmp/no_info_here.yuv") is None


def test_raw_bad_params_raises(tmp_path):
    bad = tmp_path / "x_4x4_yuv420p.yuv"
    bad.write_bytes(b"\x00" * 10)  # 4x4 单帧需 24 字节
    with pytest.raises(RawParamError):
        infer_raw_or_raise(str(bad))


def test_frame_planes_and_half_pixel_difference(clip_dir):
    d, _ = clip_dir
    m = open_media(os.path.join(d, "pat_horizontal.mkv"))
    y, u, v = m.read_frame_planes(0)
    pf = m.pixel_format
    rgb_left = reconstruct_rgb(y, u, v, pf, ChromaSite.LEFT, m.matrix_key, False)
    rgb_center = reconstruct_rgb(y, u, v, pf, ChromaSite.CENTER, m.matrix_key, False)
    assert rgb_left.shape == (H, W, 3)
    # 两种解释在色边附近必须产生不同像素
    assert not np.array_equal(rgb_left, rgb_center)
    diff_cols = np.where(np.any(rgb_left != rgb_center, axis=(0, 2)))[0]
    # 差异列紧邻声明边沿（色度列 64 -> 亮度 x≈128）
    assert diff_cols.min() <= 128 <= diff_cols.max() + 1


def test_neutral_pattern_stays_neutral_both_sites(clip_dir):
    d, _ = clip_dir
    m = open_media(os.path.join(d, "pat_neutral.mkv"))
    y, u, v = m.read_frame_planes(3)
    pf = m.pixel_format
    for site in (ChromaSite.LEFT, ChromaSite.CENTER, ChromaSite.TOP):
        rgb = reconstruct_rgb(y, u, v, pf, site, m.matrix_key, False)
        np.testing.assert_array_equal(rgb[..., 0], rgb[..., 1])
        np.testing.assert_array_equal(rgb[..., 1], rgb[..., 2])


def test_vertical_pattern_distinguishes_top_and_center(clip_dir):
    d, _ = clip_dir
    m = open_media(os.path.join(d, "pat_vertical.mkv"))
    y, u, v = m.read_frame_planes(0)
    pf = m.pixel_format
    rgb_top = reconstruct_rgb(y, u, v, pf, ChromaSite.TOP, m.matrix_key, False)
    rgb_ctr = reconstruct_rgb(y, u, v, pf, ChromaSite.CENTER, m.matrix_key, False)
    assert not np.array_equal(rgb_top, rgb_ctr)


def test_motion_clip_advances(clip_dir):
    d, _ = clip_dir
    m = open_media(os.path.join(d, "pat_motion.mkv"))
    _, u0, _ = m.read_frame_planes(0)
    _, u1, _ = m.read_frame_planes(1)
    assert not np.array_equal(u0, u1)


def test_new_file_does_not_inherit_declaration(clip_dir):
    """需求 3：切文件不沿用别的文件声明。"""
    d, _ = clip_dir
    with_decl = open_media(os.path.join(d, "pat_horizontal.mkv"))
    without = open_media(os.path.join(d, "pat_neutral.mkv"))
    assert with_decl.declared_site == ChromaSite.LEFT
    assert without.declared_site is None


def test_reject_rgb_file(tmp_path):
    out = tmp_path / "rgb.avi"
    import subprocess
    # AVI + ffv1 能保留 rgb24 封装；mp4 会被自动转成 YUV
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=red:s=16x16:d=0.2",
         "-pix_fmt", "rgb24", "-c:v", "ffv1", str(out)],
        check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=pix_fmt", "-of",
         "default=nw=1:nk=1", str(out)],
        capture_output=True, text=True,
    )
    assert probe.stdout.strip() in ("rgb24", "bgr0")
    with pytest.raises(UnsupportedPixelFormat, match="RGB|BGRx"):
        open_media(str(out))
