"""转换管线：把 PAR 与方向烘焙进像素，并在转完后回读校验。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional

from .geometry import VideoGeometry
from .probe import ProbeResult, probe


@dataclass
class ExportOptions:
    output_path: str
    even_policy: str = "nearest"          # "nearest" | "down"
    video_codec: str = "libx264"
    pix_fmt: str = "yuv420p"
    crf: int = 16


@dataclass
class VerificationReport:
    ok: bool
    coded_size: tuple
    sample_aspect_ratio: str
    rotation: Optional[float]
    expected_size: tuple
    has_audio: bool
    audio_codec: Optional[str]
    video_duration: Optional[float]
    audio_duration: Optional[float]
    container_duration: Optional[float]
    duration_diff_ms: Optional[float]
    checks: List[str] = field(default_factory=list)
    failures: List[str] = field(default_factory=list)

    def summary_lines(self) -> List[str]:
        lines = list(self.checks)
        if self.duration_diff_ms is not None:
            lines.append(
                f"音视频有效时长差：{self.duration_diff_ms:.0f} ms"
                f"（视频 {self.video_duration:.3f}s / "
                f"音频 {self.audio_duration:.3f}s）"
            )
        lines.append(f"容器时长：{self.container_duration:.3f}s")
        if self.failures:
            lines.append("")
            lines.extend("失败：" + f for f in self.failures)
        return lines


def build_export_command(
    src: ProbeResult, opts: ExportOptions
) -> List[str]:
    """构造 ffmpeg 命令。

    关键点（均已在 ffmpeg 9 实测）：
    - ``-noautorotate`` 阻止 ffmpeg 自动按元数据旋转；
    - 输入侧 ``-display_rotation 0`` 把旋转矩阵清零，
      不加它，transpose 之后元数据仍残留，播放器会再转一次；
    - PAR 与旋转全部由 -vf 滤镜烘焙，输出 setsar=1。
    """
    g: VideoGeometry = src.geometry
    out_w, out_h = g.output_size(opts.even_policy)
    vf = g.bake_filter_chain(out_w, out_h)

    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-noautorotate",
        "-display_rotation", "0",
        "-i", src.path,
        "-map", "0:v:0",
        "-vf", vf,
        "-c:v", opts.video_codec,
        "-pix_fmt", opts.pix_fmt,
        "-crf", str(opts.crf),
    ]
    if src.has_audio:
        # 先尝试原样保留声音（节奏/采样完全不动）；
        # 容器不接纳该编码时由调用方回退到 AAC 重编码。
        cmd += ["-map", "0:a:0", "-c:a", "copy"]
    cmd.append(opts.output_path)
    return cmd


def export(
    src: ProbeResult,
    opts: ExportOptions,
    runner: Optional[Callable[[List[str]], int]] = None,
    log: Optional[Callable[[str], None]] = None,
) -> str:
    """执行导出，返回输出路径。失败时带 ffmpeg stderr 抛错。"""
    from .ffutils import run_ffmpeg

    log = log or (lambda msg: None)
    out_w, out_h = src.geometry.output_size(opts.even_policy)
    log(
        f"目标成片：{out_w}x{out_h}（方形像素），"
        f"取整策略：{opts.even_policy}"
    )

    cmd = build_export_command(src, opts)
    log("执行：" + " ".join(cmd))
    code, stderr = run_ffmpeg(cmd, runner)
    if code != 0:
        if src.has_audio and "-c:a" in cmd:
            # 音轨 copy 失败（典型：mp4 装不下 pcm/flac 等），回退 AAC
            log("音轨直接拷贝失败，回退 AAC 重编码（保持原采样率与声道）…")
            cmd = _fallback_aac(cmd)
            log("执行：" + " ".join(cmd))
            code, stderr = run_ffmpeg(cmd, runner)
        if code != 0:
            tail = "\n".join(stderr.strip().splitlines()[-12:])
            raise RuntimeError(f"ffmpeg 导出失败：\n{tail}")
    return opts.output_path


def _fallback_aac(cmd: List[str]) -> List[str]:
    out = []
    skip_next = False
    for i, token in enumerate(cmd):
        if skip_next:
            skip_next = False
            continue
        if token == "copy" and i >= 1 and cmd[i - 1] == "-c:a":
            out.append("aac")
            out.extend(["-b:a", "192k"])
            continue
        out.append(token)
    return out


def verify_export(
    output_path: str,
    expected_size: tuple,
    expected_audio: bool,
    duration_tolerance_ms: float = 80.0,
) -> VerificationReport:
    """回读成片，检查尺寸、方向、PAR、音轨与有效时长。"""
    result = probe(output_path)
    g = result.geometry
    checks: List[str] = []
    failures: List[str] = []

    # 1. 尺寸
    actual_size = (g.coded_width, g.coded_height)
    if actual_size == tuple(expected_size):
        checks.append(f"编码尺寸：{actual_size[0]}x{actual_size[1]}，与计划一致")
    else:
        failures.append(
            f"尺寸不符：实际 {actual_size}，预期 {tuple(expected_size)}"
        )

    # 2. 方形像素
    if g.is_square_pixel:
        checks.append("像素宽高比：1:1（方形像素）")
    else:
        failures.append(f"PAR 不是 1:1：{g.par_num}:{g.par_den}")

    # 3. 方向元数据必须清零，播放器不会再转第二次
    if result.raw_rotation in (None, 0.0) and not g.mirrored:
        checks.append("显示方向：无旋转/镜像元数据（不会被二次旋转）")
    else:
        failures.append(
            f"仍残留方向信息：rotation={result.raw_rotation}, mirrored={g.mirrored}"
        )

    # 4. 音轨
    if expected_audio:
        if result.has_audio:
            checks.append(
                f"音轨：保留（{result.audio.codec}，{result.audio.channels} 声道）"
            )
        else:
            failures.append("源文件有音轨，但成片丢了声音")
    else:
        if not result.has_audio:
            checks.append("音轨：源无音轨，成片同样无音轨")
        else:
            failures.append("源文件无音轨，但成片莫名出现音轨")

    # 5. 有效时长
    diff_ms = None
    vdur = result.video_duration or result.container_duration
    if vdur is None:
        failures.append("读不到视频时长")
    else:
        checks.append(f"视频有效时长：{vdur:.3f}s")
        if result.has_audio:
            adur = result.audio.duration
            if adur is None:
                failures.append("读不到音频时长")
            else:
                diff_ms = abs(vdur - adur) * 1000.0
                if diff_ms > duration_tolerance_ms:
                    failures.append(
                        f"音视频时长差 {diff_ms:.0f}ms 超过容差 "
                        f"{duration_tolerance_ms:.0f}ms"
                    )
        else:
            checks.append("无音轨，跳过音画时长对齐检查")

    return VerificationReport(
        ok=not failures,
        coded_size=actual_size,
        sample_aspect_ratio=f"{g.par_num}:{g.par_den}",
        rotation=result.raw_rotation,
        expected_size=tuple(expected_size),
        has_audio=result.has_audio,
        audio_codec=result.audio.codec if result.audio else None,
        video_duration=vdur,
        audio_duration=result.audio.duration if result.audio else None,
        container_duration=result.container_duration,
        duration_diff_ms=diff_ms,
        checks=checks,
        failures=failures,
    )
