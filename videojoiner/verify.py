"""导出后回读校验：实际时长/尺寸/帧率、片段顺序、交界黑帧与重复帧、音轨。

所有判断只依赖回读导出文件本身（外加时间线的预期值），
不使用导出阶段的中间变量，确保发现的是成品文件里的真实问题。
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field

from .probe import MediaInfo, ProbeError, probe_media
from .runner import ffmpeg_bin
from .samples import SAMPLE_SPECS

# 样例颜色 → 主导通道位置（0=R,1=G,2=B）。
# 不比较绝对色值：yuv420p 有限范围转换、contain 黑边平均、cover 裁切都会改变
# RGB 数值，但"由哪些通道主导"这一色相特征稳定不变，足以区分六种样例颜色。
_DOMINANT_CHANNELS = {
    "red":    (0,),
    "green":  (1,),
    "blue":   (2,),
    "yellow": (0, 1),
    "purple": (0, 2),
    "cyan":   (1, 2),
}

# 样例文件名 → 主导通道签名（SAMPLE_SPECS 第 1 项文件名，第 6 项颜色名）
EXPECTED_SAMPLE_SIGNATURE: dict[str, tuple[int, ...]] = {
    spec[0]: _DOMINANT_CHANNELS[spec[5]] for spec in SAMPLE_SPECS
}


def dominant_signature(rgb: tuple[int, int, int]) -> tuple[int, ...]:
    """返回主导通道位置：通道值达到最大通道 50% 以上即视为主导。"""
    peak = max(rgb)
    if peak < 16:  # 接近全黑，无法判定色相
        return tuple()
    return tuple(i for i, value in enumerate(rgb) if value >= 0.5 * peak)


class VerifyError(RuntimeError):
    pass


@dataclass
class CheckItem:
    name: str
    passed: bool
    detail: str


@dataclass
class VerifyReport:
    output_path: str
    actual: MediaInfo | None = None
    checks: list[CheckItem] = field(default_factory=list)
    junction_frames: list[dict] = field(default_factory=list)
    order_samples: list[dict] = field(default_factory=list)
    audio_segments: list[dict] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    def to_dict(self) -> dict:
        return {
            "output_path": self.output_path,
            "passed": self.passed,
            "actual": None if self.actual is None else _media_to_dict(self.actual),
            "checks": [c.__dict__ for c in self.checks],
            "junction_frames": self.junction_frames,
            "order_samples": self.order_samples,
            "audio_segments": self.audio_segments,
        }


def _media_to_dict(info: MediaInfo) -> dict:
    from dataclasses import asdict
    return asdict(info)


# ---------------- ffmpeg 采样原语 ----------------

def read_frame_rgb(path: str, at_seconds: float, scale: int = 64) -> tuple[int, int, int]:
    """读取指定时刻一帧，缩放到 scale x scale 后返回平均 RGB。"""
    cmd = [
        ffmpeg_bin(), "-v", "error",
        "-ss", f"{at_seconds:.3f}", "-i", path,
        "-frames:v", "1",
        "-vf", f"scale={scale}:{scale},format=rgb24",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise VerifyError(f"读取 {at_seconds:.3f}s 处画面失败")
    data = proc.stdout
    count = len(data) // 3
    r = sum(data[0::3]) / count
    g = sum(data[1::3]) / count
    b = sum(data[2::3]) / count
    return round(r), round(g), round(b)


def read_black_level(path: str, at_seconds: float) -> float:
    """返回指定帧的平均亮度 YAVG（0=全黑，~235=全亮）。"""
    cmd = [
        ffmpeg_bin(), "-v", "info",
        "-ss", f"{at_seconds:.3f}", "-i", path,
        "-frames:v", "1",
        "-vf", "signalstats,metadata=print",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    for line in proc.stderr.splitlines():
        if "YAVG=" in line:
            try:
                return float(line.split("YAVG=")[1].split()[0])
            except (IndexError, ValueError):
                continue
    raise VerifyError(f"无法解析 {at_seconds:.3f}s 处帧亮度")


def read_audio_rms(path: str, start: float, duration: float) -> float:
    """读取 [start, start+duration] 区间的整体 RMS 电平（dBFS），静音约 -91。"""
    cmd = [
        ffmpeg_bin(), "-v", "info",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", path,
        "-vn", "-af", "astats=metadata=1:reset=0",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    # 新版 ffmpeg 的 astats 按声道逐块打印，取最后一个 RMS level 作为整体汇总
    overall = None
    for line in proc.stderr.splitlines():
        if "RMS level dB:" in line:
            try:
                overall = float(line.split("RMS level dB:")[1].split()[0])
            except (IndexError, ValueError):
                pass
    if overall is None:
        raise VerifyError("无法解析音频 RMS（文件可能没有音轨）")
    return overall


def _color_close(actual: tuple[int, int, int],
                 expected: tuple[int, int, int], tol: int = 24) -> bool:
    return all(abs(a - e) <= tol for a, e in zip(actual, expected))


# ---------------- 主校验入口 ----------------

def verify_export(output_path: str, project, silence_tol_db: float = -60.0) -> VerifyReport:
    """回读成品并与 project 时间线的预期逐项核对。"""
    report = VerifyReport(output_path=output_path)

    # 1) 成品可被 ffprobe 读取，尺寸/帧率/音轨符合输出设置
    try:
        actual = probe_media(output_path)
    except ProbeError as exc:
        report.checks.append(CheckItem("成品文件可读", False, f"ffprobe 失败：{exc}"))
        return report
    report.actual = actual
    resolved = project.effective_settings()

    report.checks.append(CheckItem(
        "输出尺寸",
        (actual.width, actual.height) == (resolved.width, resolved.height),
        f"实际 {actual.width}x{actual.height}，期望 {resolved.width}x{resolved.height}"))
    report.checks.append(CheckItem(
        "输出帧率",
        abs(actual.fps - resolved.fps) < 0.15,
        f"实际 {actual.fps:g}fps，期望 {resolved.fps:g}fps"))
    report.checks.append(CheckItem(
        "成品含音轨",
        actual.has_audio,
        "含 AAC 音轨" if actual.has_audio else "缺少音轨（静音片段也应补静音轨）"))

    expected_duration = project.estimated_duration()
    # 允许误差：每段 1 帧 + 固定 60ms 容器/编码余量
    frame_slack = len(project.valid_clips) / resolved.fps + 0.06
    duration_ok = abs(actual.duration - expected_duration) <= frame_slack
    report.checks.append(CheckItem(
        "总时长",
        duration_ok,
        f"实际 {actual.duration:.3f}s，预计 {expected_duration:.3f}s，"
        f"容差 ±{frame_slack:.3f}s"))

    # 2) 片段顺序：在每段时间窗中心取色，与样例期望色比对
    boundaries = _boundaries(project)
    clips = project.valid_clips
    order_ok = True
    for index, (start, end) in enumerate(zip([0.0] + boundaries[:-1], boundaries)):
        center = (start + end) / 2
        try:
            rgb = read_frame_rgb(output_path, center)
        except VerifyError as exc:
            report.order_samples.append({"index": index, "error": str(exc)})
            order_ok = False
            continue
        import os
        name = os.path.basename(clips[index].path)
        expected_sig = EXPECTED_SAMPLE_SIGNATURE.get(name)
        actual_sig = dominant_signature(rgb)
        if expected_sig is None:
            matched = None  # 非程序样例，只记录颜色不做判定
        else:
            matched = actual_sig == expected_sig
            order_ok = order_ok and bool(matched)
        report.order_samples.append({
            "index": index, "at": round(center, 3),
            "actual_rgb": list(rgb),
            "actual_signature": list(actual_sig),
            "expected_signature": list(expected_sig) if expected_sig else None,
            "matched": matched,
        })
    if any(s.get("expected_signature") for s in report.order_samples):
        report.checks.append(CheckItem(
            "片段顺序（按样例特征色核对）", order_ok,
            "各时间窗中心颜色与片段顺序一致" if order_ok
            else "存在时间窗颜色与预期片段不符，顺序可能错乱"))
    else:
        report.checks.append(CheckItem(
            "片段顺序（按时间窗采样）", True,
            "非程序样例，已记录各时间窗颜色供人工核对"))

    # 3) 交界：交界两侧各取一帧，检查黑帧与重复帧
    junctions_ok = True
    for boundary in boundaries[:-1]:
        before_t = max(boundary - 0.08, 0.0)
        after_t = min(boundary + 0.08, actual.duration - 0.02)
        try:
            y_before = read_black_level(output_path, before_t)
            y_after = read_black_level(output_path, after_t)
            rgb_before = read_frame_rgb(output_path, before_t)
            rgb_after = read_frame_rgb(output_path, after_t)
        except VerifyError as exc:
            junctions_ok = False
            report.junction_frames.append(
                {"boundary": boundary, "error": str(exc)})
            continue
        black = y_before < 12 or y_after < 12
        duplicate = _color_close(rgb_before, rgb_after, tol=8)
        entry = {
            "boundary": round(boundary, 3),
            "luma_before": round(y_before, 1), "luma_after": round(y_after, 1),
            "black_frame": black,
            "duplicate_frame": duplicate,
        }
        report.junction_frames.append(entry)
        if black or duplicate:
            junctions_ok = False
    if boundaries[:-1]:
        report.checks.append(CheckItem(
            "片段交界（黑帧/重复帧）", junctions_ok,
            "全部交界两侧帧亮度正常且画面不同" if junctions_ok
            else "存在交界黑帧或重复帧，请查看 junction_frames 明细"))

    # 4) 音频：逐段检查 RMS——源无声的段应静音，源有声的段应有能量
    if actual.has_audio:
        audio_ok = True
        cursor = 0.0
        for index, clip in enumerate(clips):
            dur = clip.info.duration
            probe_len = max(dur * 0.5, 0.3)
            try:
                rms = read_audio_rms(output_path, cursor + dur * 0.25, probe_len)
            except VerifyError as exc:
                audio_ok = False
                report.audio_segments.append({"index": index, "error": str(exc)})
                cursor += dur
                continue
            if clip.info.has_audio:
                segment_ok = rms > silence_tol_db
                expectation = f"应有声音（RMS > {silence_tol_db}dBFS）"
            else:
                segment_ok = rms <= silence_tol_db
                expectation = f"应为补入的静音（RMS ≤ {silence_tol_db}dBFS）"
            if not segment_ok:
                audio_ok = False
            report.audio_segments.append({
                "index": index, "rms_db": round(rms, 1),
                "source_had_audio": clip.info.has_audio,
                "passed": segment_ok, "expectation": expectation,
            })
            cursor += dur
        report.checks.append(CheckItem(
            "音画分段对齐（有声段有能量 / 无声段为静音）", audio_ok,
            "各段音频状态与源片段一致，未发生提前或偏移" if audio_ok
            else "存在音频能量与源片段声音状态不符的时间段"))

    return report


def _boundaries(project) -> list[float]:
    """根据每段实际时长计算累计交界时间点（含结尾）。"""
    boundaries: list[float] = []
    cursor = 0.0
    for clip in project.valid_clips:
        cursor += clip.info.duration
        boundaries.append(round(cursor, 3))
    return boundaries
