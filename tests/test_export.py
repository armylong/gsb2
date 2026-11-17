"""时间点切换、导出与回读校验的集成测试。"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from greenscreen import ExportError, MediaError
from greenscreen.exporter import export_video, verify_export
from greenscreen.keying import KeyingParams, process_frame
from greenscreen.media import VideoReader, probe_video
from greenscreen.generate_test_assets import WIDTH, HEIGHT


def test_seek_returns_requested_frames(reader):
    """随机定位必须精确返回目标帧（时间点切换验证）。"""
    total = reader.frame_count
    targets = [0, total // 4, total // 2, total - 1, total // 3, 0]
    seen = []
    for idx in targets:
        frame = reader.read_frame(idx)
        assert frame is not None
        assert frame.shape == (HEIGHT, WIDTH, 3)
        seen.append(frame)
    # 跳回第 0 帧的结果应与第一次读取一致（可重复定位）
    np.testing.assert_array_equal(seen[0], seen[-1])
    # 不同时间点人物位置在变化，帧内容不应全部相同
    assert not np.array_equal(seen[1], seen[3])


def test_render_same_frame_same_output(reader, background):
    """同一帧无论读几次，处理结果必须一致（预览/导出一致性基础）。"""
    params = KeyingParams()
    f1 = process_frame(reader.read_frame(10), background, params)["composite"]
    f2 = process_frame(reader.read_frame(10), background, params)["composite"]
    np.testing.assert_array_equal(f1, f2)


def test_export_roundtrip_with_audio(assets, background, tmp_path):
    """完整导出 + 回读：尺寸/帧数/音轨一致，且文件能实际解码。"""
    out = tmp_path / "out_composed.mp4"
    params = KeyingParams()
    result = export_video(
        assets["video"], assets["background"], out, params
    )

    assert out.exists() and out.stat().st_size > 0
    assert result["verified"] is True
    assert (result["width"], result["height"]) == (WIDTH, HEIGHT)
    assert result["has_audio"] is True  # 源带正弦波音轨

    info = probe_video(out)
    assert info.has_audio is True                       # 音轨保留
    assert (info.width, info.height) == (WIDTH, HEIGHT)
    assert abs(info.frame_count - reader_frame_count(assets)) <= 2
    assert abs(info.fps - probe_video(assets["video"]).fps) < 0.5

    # 实际解码出的画面应是“合成后”的画面，而非原始绿幕：
    # 背景区域必须接近背景图颜色，而不是绿色
    cap = cv2.VideoCapture(str(out))
    ok, frame = cap.read()
    cap.release()
    assert ok and frame is not None
    corner = frame[4:12, 4:12].mean(axis=(0, 1))
    bg_corner = cv2.resize(background, (WIDTH, HEIGHT))[4:12, 4:12].mean(axis=(0, 1))
    assert np.abs(corner.astype(int) - bg_corner.astype(int)).mean() < 25


def test_export_pixels_match_preview(assets, tmp_path):
    """导出文件解码出的帧与同一参数下 process_frame 的预览逐像素接近。"""
    out = tmp_path / "match.mp4"
    params = KeyingParams(edge_feather=0.3, spill_strength=0.7)
    export_video(assets["video"], assets["background"], out, params)

    bg = cv2.imdecode(
        np.fromfile(str(assets["background"]), np.uint8), cv2.IMREAD_COLOR)
    with VideoReader(str(assets["video"])) as src:
        preview = process_frame(src.read_frame(5), bg, params)["composite"]

    cap = cv2.VideoCapture(str(out))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 5)
    ok, exported = cap.read()
    cap.release()
    assert ok
    # 有损 H.264 压缩，允许小的编码误差，但整体必须高度一致
    diff = np.abs(preview.astype(int) - exported.astype(int)).mean()
    assert diff < 6.0


def test_export_without_audio(assets, tmp_path):
    """无音轨源视频导出后同样可正常回读，且不被误报为含音轨。"""
    silent_src = tmp_path / "silent.mp4"
    import subprocess
    from greenscreen.media import find_ffmpeg
    subprocess.run(
        [find_ffmpeg(), "-y", "-loglevel", "error", "-i",
         str(assets["video"]), "-an", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", str(silent_src)], check=True)

    out = tmp_path / "silent_out.mp4"
    result = export_video(silent_src, assets["background"], out, KeyingParams())
    assert result["has_audio"] is False
    assert probe_video(out).has_audio is False


def test_export_rejects_bad_extension(assets, tmp_path):
    with pytest.raises(ExportError):
        export_video(assets["video"], assets["background"],
                     tmp_path / "x.wmv", KeyingParams())


def test_failed_export_leaves_no_file(assets, tmp_path):
    """校验/编码失败时不能留下看似成功却无法播放的文件。"""
    out = tmp_path / "ghost.mp4"
    # 用不存在的背景图触发导出前置失败
    with pytest.raises(ExportError):
        export_video(assets["video"], tmp_path / "missing.png",
                     out, KeyingParams())
    assert not out.exists()
    assert not (tmp_path / "ghost.silent.mp4").exists()


def test_verify_export_rejects_garbage(tmp_path):
    garbage = tmp_path / "garbage.mp4"
    garbage.write_bytes(b"this is definitely not a video")
    expected = probe_video_path_type(garbage)
    with pytest.raises(ExportError):
        verify_export(garbage, expected)
    assert not garbage.exists()  # 校验失败的文件应被删除


def reader_frame_count(assets) -> int:
    return probe_video(assets["video"]).frame_count


def probe_video_path_type(path: Path):
    """构造一个最小 VideoInfo 形状的对象用于校验函数。"""
    from greenscreen.media import VideoInfo
    return VideoInfo(WIDTH, HEIGHT, 24.0, 72, 3.0, True, [])
