"""ffprobe/ffmpeg 封装测试: 全部断言基于真实解码输出, 不只比较配置。"""

import subprocess

import numpy as np
import pytest

from proxy_check.errors import MediaProbeError
from proxy_check.ffmedia import (
    GRID_H, GRID_W, content_digest, decode_gray_frames, probe, probe_packet_pts,
    sha256_file,
)


def test_source_is_cfr_with_real_packets(paths, source_info):
    pts = probe_packet_pts(paths["source"])
    # 帧数来自真实 packet 计数, 30fps * 10s = 300。
    assert len(pts) == 300
    assert source_info.nb_video_frames == 300
    deltas = np.diff(np.asarray(pts))
    # 排序后呈现顺序单调, 间隔稳定在 1/30 附近。
    assert np.all(np.diff(pts) > 0)
    assert np.max(np.abs(deltas - 1.0 / 30.0)) < 5e-4


def test_probe_reports_real_dimensions_duration_audio(paths):
    info = probe(paths["source"])
    assert (info.width, info.height) == (960, 540)
    assert info.frame_rate == pytest.approx(30.0, abs=1e-3)
    assert 9.9 < info.duration <= 10.1
    assert info.has_audio and info.audio_sample_rate == 48000
    assert info.audio_duration == pytest.approx(10.0, abs=0.1)
    assert info.video_duration == pytest.approx(10.0, abs=0.05)


def test_decode_gray_frames_real_output(paths):
    all_frames = decode_gray_frames(paths["source"], GRID_W, GRID_H)
    assert all_frames.shape == (300, GRID_H, GRID_W)
    assert all_frames.dtype == np.float32
    assert 0.0 <= all_frames.min() and all_frames.max() <= 1.0
    # 真实移动图形: 相邻帧不可能完全相同。
    assert not np.allclose(all_frames[0], all_frames[10])

    picked = decode_gray_frames(
        paths["source"], GRID_W, GRID_H, frame_indices=[0, 50, 299])
    assert picked.shape == (3, GRID_H, GRID_W)
    assert np.allclose(picked[0], all_frames[0], atol=1e-6)
    assert np.allclose(picked[2], all_frames[299], atol=1e-6)


def test_content_digest_stable_and_distinguishes_content(paths):
    d1, frames1 = content_digest(paths["source"])
    d2, _ = content_digest(paths["source"])
    assert d1 == d2 and len(d1) == 64
    d_other, _ = content_digest(paths["different"])
    assert d_other != d1
    # 文件哈希与内容指纹是两个不同概念。
    assert sha256_file(paths["source"]) != d1


def test_good_proxy_real_frame_count_matches_source(paths):
    src = probe(paths["source"])
    good = probe(paths["good"])
    assert good.nb_video_frames == src.nb_video_frames
    assert good.height == 360
    assert good.width == 640  # 960:540 = 16:9
    assert good.has_audio


def test_offset_proxy_preserves_count_but_shifts_content(paths):
    offset = probe(paths["offset"])
    assert offset.nb_video_frames == 300  # 补黑帧后总数不变
    grid_src = decode_gray_frames(paths["source"], GRID_W, GRID_H)
    grid_off = decode_gray_frames(paths["offset"], GRID_W, GRID_H)
    # 未对齐时(同序号)内容可区分; 对齐 15 帧后内容一致。
    direct = np.mean(np.abs(grid_src[15] - grid_off[0]))
    misaligned = np.mean(np.abs(grid_src[15] - grid_off[15]))
    assert direct < 0.02          # 代理帧0 == 原片帧15
    assert misaligned > direct + 0.02   # 错位置上的帧明显不是同一内容
    aligned = np.mean(np.abs(grid_src[15:290] - grid_off[0:275]))
    assert aligned < 0.02


def test_vfr_file_rejected(tmp_path):
    # 用 concat 思路造一个帧率突变的文件, probe 必须报 CFR 错误。
    out = tmp_path / "vfr.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0,setpts=N/(20*TB)[v]",
        "-map", "[v]", "-an", str(out),
    ], check=True)
    with pytest.raises(MediaProbeError):
        probe(out)
