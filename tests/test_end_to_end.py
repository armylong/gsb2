"""端到端核对: 样例生成 -> 导出 -> 实际解码画面逐帧比对。

覆盖需求中的硬指标:
* 输出尺寸/帧率/帧数继承背景, 音频只有一条且覆盖全程;
* 三点关键帧端点、两点中点的叠加层左上角与 Python 模型相差 <= 1px;
* 叠加结束帧(149)仍在、下一帧(150)起画面回到纯背景;
* 预览合成(numpy)与导出(ffmpeg 表达式)在同一帧上位置一致;
* 修改固定尺寸导致旧点越界时必须报错且路径不变。
"""

from __future__ import annotations

import subprocess
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest

from pipeditor.composite import render_frame
from pipeditor.exporter import build_export_command, export_mp4
from pipeditor.media import (
    build_project,
    iter_frames_rgb,
    probe,
    read_frame_rgb,
)
from pipeditor.sample import generate
from pipeditor.model import Project


def _decode_all(path, info):
    return list(iter_frames_rgb(path, info.width, info.height))


def _overlay_bbox(frame: np.ndarray):
    """定位叠加层外接矩形, 返回 (x0, y0, x1, y1) 或 None。

    叠加层是 8px 蓝色边框 + 橙色填充。优先用橙色填充(高R/中G/低B,
    背景网格不含此颜色), 其内边缘再回退 8px 得到叠加层左上角;
    橙色缺失时退回蓝色边框掩码。
    """

    r = frame[..., 0].astype(int)
    g = frame[..., 1].astype(int)
    b = frame[..., 2].astype(int)
    orange = (r > 220) & (g > 100) & (g < 180) & (b < 60)
    if orange.any():
        ys, xs = np.where(orange)
        # 填充比整层小 8px 边框; 右/下用 +8 还原外接框。
        return (
            int(xs.min()) - 8,
            int(ys.min()) - 8,
            int(xs.max()) + 1 + 8,
            int(ys.max()) + 1 + 8,
        )
    blue = (b > 140) & (b - r > 60)
    if not blue.any():
        return None
    ys, xs = np.where(blue)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _audio_mean_volume(path: str) -> float:
    proc = subprocess.run(
        ["ffmpeg", "-i", path, "-map", "0:a:0", "-af", "volumedetect",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    for line in proc.stderr.splitlines():
        if "mean_volume" in line:
            return float(line.split("mean_volume:")[1].strip().split(" ")[0])
    raise AssertionError("未检测到音频音量信息")


@pytest.fixture(scope="module")
def sample_project(tmp_path_factory):
    work = tmp_path_factory.mktemp("pip_e2e")
    paths = generate(work)
    bg = probe(str(paths["background"]))
    ov = probe(str(paths["overlay"]))
    project = build_project(bg, ov, ov.width, ov.height)
    # 样例三点路径
    for kf in [(0, 40, 40), (90, 900, 440), (180, 480, 60)]:
        project.upsert_keyframe(*kf)
    out = work / "out.mp4"
    export_mp4(bg, ov, project, str(out))
    out_info = probe(str(out))
    return {
        "bg": bg, "ov": ov, "project": project,
        "out": str(out), "out_info": out_info, "work": work,
    }


def test_output_inherits_background_spec(sample_project):
    bg, out_info = sample_project["bg"], sample_project["out_info"]
    assert (out_info.width, out_info.height) == (bg.width, bg.height)
    assert out_info.fps == bg.fps
    assert out_info.frame_count == bg.frame_count
    assert out_info.has_audio is True


def test_single_audio_stream_covers_full_duration(sample_project):
    out = sample_project["out"]
    # 只有一条音频流(叠加层的 880Hz 音轨必须被丢弃)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
         "-of", "csv=p=0", out],
        capture_output=True, text=True, check=True,
    )
    types = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
    assert types == ["video", "audio"]
    # 背景音频全程存在且有实际能量, 时长与背景一致。
    assert _audio_mean_volume(out) > -60.0
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration", "-of", "csv=p=0", out],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert abs(float(dur) - sample_project["bg"].duration) < 0.1


def test_only_background_audio_frequency_kept(sample_project):
    """FFT 核对: 成品只有背景 440Hz, 叠加层 880Hz 音轨必须不可闻。"""
    raw = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", sample_project["out"],
            "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
        ],
        capture_output=True, check=True,
    ).stdout
    audio = np.frombuffer(raw, dtype=np.int16).astype(float)
    window = np.hanning(len(audio))
    spec = np.abs(np.fft.rfft(audio * window))
    freqs = np.fft.rfftfreq(len(audio), 1 / 8000)
    peak = float(freqs[int(np.argmax(spec))])
    assert abs(peak - 440.0) < 5.0
    e440 = spec[int(np.argmin(np.abs(freqs - 440)))]
    e880 = spec[int(np.argmin(np.abs(freqs - 880)))]
    # 880Hz 残余能量不足主频的千分之一。
    assert e880 / e440 < 0.001


def test_overlay_positions_match_model_within_one_pixel(sample_project):
    p: Project = sample_project["project"]
    out_info = sample_project["out_info"]
    check_frames = [0, 45, 89, 90, 135, 149]
    for f in check_frames:
        frame = read_frame_rgb(
            sample_project["out"], out_info.width, out_info.height,
            f, out_info.fps,
        )
        bbox = _overlay_bbox(frame)
        assert bbox is not None, f"帧 {f} 找不到叠加层"
        x0, y0, x1, y1 = bbox
        exp_x, exp_y = p.position_at(f)
        # 蓝色边框在叠加层最外圈, 外接框左上角即叠加层左上角;
        # 位置是核心一致性指标, H.264 有损编码下容忍 1px。
        assert abs(x0 - exp_x) <= 1, f"帧{f} x: 解码{x0} vs 模型{exp_x}"
        assert abs(y0 - exp_y) <= 1, f"帧{f} y: 解码{y0} vs 模型{exp_y}"
        # 右/下边缘受有损编码的色度扩散影响更大, 尺寸容忍 2px。
        assert abs((x1 - x0) - p.overlay_w) <= 2
        assert abs((y1 - y0) - p.overlay_h) <= 2


def test_overlay_disappears_after_its_last_frame(sample_project):
    out_info = sample_project["out_info"]
    p = sample_project["project"]
    assert p.overlay_frame_count == 150
    last = read_frame_rgb(
        sample_project["out"], out_info.width, out_info.height, 149,
        out_info.fps,
    )
    gone = read_frame_rgb(
        sample_project["out"], out_info.width, out_info.height, 150,
        out_info.fps,
    )
    assert _overlay_bbox(last) is not None
    assert _overlay_bbox(gone) is None, "第150帧叠加层应已消失"

    # 消失后的背景必须完整保留: 与纯背景同帧画面一致(编码误差极小)。
    bg_pure = read_frame_rgb(
        sample_project["bg"].path, out_info.width, out_info.height, 150,
        out_info.fps,
    )
    diff = np.abs(gone.astype(int) - bg_pure.astype(int)).mean()
    assert diff < 2.0, f"叠加结束后背景被破坏, 平均色差 {diff}"

    # 末帧同样是纯背景。
    tail = read_frame_rgb(
        sample_project["out"], out_info.width, out_info.height,
        out_info.frame_count - 1, out_info.fps,
    )
    assert _overlay_bbox(tail) is None


def test_preview_and_export_share_same_position(sample_project):
    """numpy 预览合成与 ffmpeg 导出在同一帧给出同一左上角。"""
    p = sample_project["project"]
    out_info = sample_project["out_info"]
    for f in [0, 45, 90, 135, 149]:
        bg = read_frame_rgb(
            sample_project["bg"].path, p.canvas_w, p.canvas_h, f, p.fps
        )
        ov = read_frame_rgb(
            sample_project["ov"].path, p.overlay_w, p.overlay_h, f, p.fps
        )
        preview = render_frame(p, f, bg, ov)
        exported = read_frame_rgb(
            sample_project["out"], out_info.width, out_info.height, f,
            out_info.fps,
        )
        pb = _overlay_bbox(preview)
        eb = _overlay_bbox(exported)
        assert pb is not None and eb is not None
        assert abs(pb[0] - eb[0]) <= 1
        assert abs(pb[1] - eb[1]) <= 1


def test_oversized_overlay_is_truncated_not_extended(tmp_path):
    """叠加层比背景长时: 输出帧数/时长仍等于背景, 不被拉长。"""
    paths = generate(tmp_path / "s")
    bg = probe(str(paths["background"]))

    # 用 ffmpeg 把叠加样例循环成 12 秒(>背景 8 秒), 得到真实的长叠加文件。
    long_ov_path = tmp_path / "overlay_long.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-stream_loop", "-1", "-i", str(paths["overlay"]),
            "-t", "12", "-c", "copy", str(long_ov_path),
        ],
        check=True,
    )
    long_ov = probe(str(long_ov_path))
    assert long_ov.duration > bg.duration

    project = build_project(bg, long_ov, long_ov.width, long_ov.height)
    project.upsert_keyframe(0, 10, 10)
    out = tmp_path / "truncated.mp4"
    export_mp4(bg, long_ov, project, str(out))
    out_info = probe(str(out))
    assert out_info.frame_count == bg.frame_count
    assert abs(out_info.duration - bg.duration) < 0.1
    # 长叠加在整个背景时长内都可见(不会提前消失)。
    last = read_frame_rgb(
        str(out), out_info.width, out_info.height,
        out_info.frame_count - 1, out_info.fps,
    )
    assert _overlay_bbox(last) is not None


def test_size_change_oob_guard_with_real_project(sample_project):
    p: Project = sample_project["project"]
    # 帧 90 的点 (900,440) 在叠加变宽到 400 后越界(max_x=880)。
    bad = p.out_of_bounds_keyframes(400, 300)
    assert any(k.frame == 90 for k in bad)
    with pytest.raises(ValueError):
        p.apply_overlay_size(400, 300)
    # 路径与尺寸均未被静默修改。
    assert p.overlay_w == 320
    assert p.keyframe_at(90).x == 900


def test_fps_is_exact_fraction(sample_project):
    assert sample_project["out_info"].fps == Fraction(30, 1)


def test_lossless_output_is_pixel_perfect(sample_project):
    """rawvideo 无损导出时, 位置必须与模型 0px 偏差(证明引擎本身精确)。

    H.264 成品里的 <=1px 偏差仅来自最终有损编码, 不是坐标/插值逻辑误差。
    """
    p: Project = sample_project["project"]
    raw_path = Path(sample_project["work"]) / "lossless.rgb"
    full = build_export_command(
        sample_project["bg"], sample_project["ov"], p, str(raw_path)
    )
    filter_complex = full[full.index("-filter_complex") + 1]
    duration = p.frame_count / float(p.fps)
    raw_cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", sample_project["bg"].path,
        "-i", sample_project["ov"].path,
        "-filter_complex", filter_complex,
        "-map", "[v]",
        "-r", f"{float(p.fps):g}",
        "-frames:v", str(p.frame_count),
        "-t", f"{duration:.6f}",
        "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo",
        "-an",
        str(raw_path),
    ]
    subprocess.run(raw_cmd, check=True, capture_output=True)

    frame_size = p.canvas_w * p.canvas_h * 3
    data = raw_path.read_bytes()
    assert len(data) == frame_size * p.frame_count
    for f in range(p.overlay_frame_count):
        a = np.frombuffer(
            data[f * frame_size:(f + 1) * frame_size], dtype=np.uint8
        ).reshape(p.canvas_h, p.canvas_w, 3)
        bbox = _overlay_bbox(a)
        assert bbox is not None, f"无损帧 {f} 缺叠加层"
        exp = p.position_at(f)
        assert bbox[0] == exp[0], f"无损帧{f} x {bbox[0]} != {exp[0]}"
        assert bbox[1] == exp[1], f"无损帧{f} y {bbox[1]} != {exp[1]}"
    # 叠加结束后纯背景
    gone = np.frombuffer(
        data[150 * frame_size:151 * frame_size], dtype=np.uint8
    ).reshape(p.canvas_h, p.canvas_w, 3)
    assert _overlay_bbox(gone) is None
