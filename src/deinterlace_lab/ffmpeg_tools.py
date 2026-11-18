"""ffmpeg / ffprobe 的薄封装。

只做三件事:
1. 用 ffprobe 读取容器/流级别的真实元数据 (尺寸、帧率、场标记、音频、逐帧 pts);
2. 用 ffmpeg 解码/去隔行, 输出原始 RGB 帧或落盘文件;
3. 所有时间戳都来自 ffprobe 实测, 不用「平均帧率 × 帧号」反推。

本模块不依赖 PySide6, 方便在无 GUI 的验证脚本里复用。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path


class FFmpegError(RuntimeError):
    """ffmpeg/ffprobe 执行失败。"""


def find_executable(name: str) -> str:
    exe = shutil.which(name)
    if not exe:
        raise FFmpegError(
            f"找不到 {name}, 请先安装 ffmpeg (macOS: brew install ffmpeg) 并加入 PATH"
        )
    return exe


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(
            f"命令执行失败 ({proc.returncode}):\n{' '.join(cmd)}\n{proc.stderr.strip()}"
        )
    return proc


def ffprobe_json(path: str | Path, args: list[str]) -> dict:
    exe = find_executable("ffprobe")
    cmd = [exe, "-hide_banner", "-loglevel", "error", *args, str(path)]
    proc = _run(cmd)
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:  # pragma: no cover - 防御性
        raise FFmpegError(f"ffprobe 输出无法解析: {proc.stdout!r}") from exc


@dataclass
class MediaInfo:
    """容器与视频流的真实信息。field_order 只作为场序初值, 不是绝对判断。"""

    path: Path
    width: int
    height: int
    frame_rate: Fraction          # 平均帧率 (CFR 素材等于 r_frame_rate)
    duration: float               # 容器级时长 (秒)
    nb_frames: int                # 实际视频帧数 (逐帧 count 得到)
    field_order: str              # tt / bb / tb / bt / progressive / unknown
    interlaced: bool              # 是否存在被标记为交错的帧
    has_audio: bool
    audio_codec: str | None
    video_codec: str
    frame_pts: list[float] = field(default_factory=list)

    @property
    def frame_period(self) -> float:
        return float(1 / self.frame_rate)

    @property
    def field_period(self) -> float:
        """每个场的时间间隔 = 输入帧间隔的一半。"""
        return self.frame_period / 2.0

    @property
    def field_order_label(self) -> str:
        return {
            "tt": "上场优先 TFF (文件标记)",
            "bb": "下场优先 BFF (文件标记)",
            "tb": "顶场在前 (文件标记)",
            "bt": "底场在前 (文件标记)",
            "progressive": "逐行 (文件标记)",
        }.get(self.field_order, f"未知场序 ({self.field_order})")


def probe_media(path: str | Path, read_pts: bool = True) -> MediaInfo:
    """读取素材元数据; read_pts 时额外逐帧读取真实 pts。"""
    path = Path(path)
    data = ffprobe_json(
        path,
        [
            "-show_format",
            "-show_streams",
            "-print_format", "json",
        ],
    )
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise FFmpegError("文件里没有视频流")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    width = int(video["width"])
    height = int(video["height"])
    rate = Fraction(video.get("r_frame_rate", "0/1"))
    if rate <= 0:
        rate = Fraction(video.get("avg_frame_rate", "0/1"))
    if rate <= 0:
        raise FFmpegError("无法读取帧率, 本工具只支持恒定帧率素材")

    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0.0)
    field_order = video.get("field_order", "unknown") or "unknown"

    # 逐帧读真实 pts 与交错标记, 而不是只信流级 tag。
    frame_pts: list[float] = []
    interlaced = False
    nb_frames = 0
    tff_votes = 0
    bff_votes = 0
    if read_pts:
        frames = ffprobe_json(
            path,
            [
                "-select_streams", "v:0",
                "-show_frames",
                "-show_entries", "frame=pts_time,interlaced_frame,top_field_first",
                "-print_format", "json",
            ],
        ).get("frames", [])
        for fr in frames:
            nb_frames += 1
            if fr.get("interlaced_frame") == 1:
                interlaced = True
                if fr.get("top_field_first") == 1:
                    tff_votes += 1
                else:
                    bff_votes += 1
            pts = fr.get("pts_time")
            if pts not in (None, "N/A"):
                frame_pts.append(float(pts))
    if nb_frames == 0:
        nb_frames = int(video.get("nb_frames") or 0) or round(duration * float(rate))
    if not frame_pts:
        # 退路: 仍按真实帧率生成等间隔 pts (CFR 前提), 但标注来源是估算。
        frame_pts = [i / float(rate) for i in range(nb_frames)]

    # 流级 field_order 在某些封装/编码器下会回退成 tt, 不可全信;
    # 当存在逐帧交错标记时, 以多数帧的 top_field_first 投票作为场序真值。
    if interlaced and (tff_votes or bff_votes):
        field_order = "tt" if tff_votes >= bff_votes else "bb"

    return MediaInfo(
        path=path,
        width=width,
        height=height,
        frame_rate=rate,
        duration=duration,
        nb_frames=nb_frames,
        field_order=field_order,
        interlaced=interlaced,
        has_audio=audio is not None,
        audio_codec=audio.get("codec_name") if audio else None,
        video_codec=video.get("codec_name", "unknown"),
        frame_pts=frame_pts,
    )


def build_video_filter(mode: str, parity: str) -> str:
    """构造去隔行/直通的视频滤镜链。

    mode:
      raw    -> 原始合帧, 不做去隔行 (保留梳齿)
      single -> yadif 每输入帧输出一帧
      double -> yadif 每场输出一帧 (2x 帧率, 保留两场运动)
    parity: "tff" 或 "bff", 由用户指定, 不使用 yadif 的 auto。
    """
    if parity not in ("tff", "bff"):
        raise ValueError("parity 必须是 tff 或 bff")
    if mode == "raw":
        return "null"
    yadif_mode = {"single": 0, "double": 1}[mode]
    yadif_parity = {"tff": 0, "bff": 1}[parity]
    return f"yadif=mode={yadif_mode}:parity={yadif_parity}:deint=all"


def decode_frames(
    path: str | Path,
    mode: str,
    parity: str,
    *,
    pix_fmt: str = "rgb24",
):
    """启动 ffmpeg 进程, stdout 持续输出原始像素帧。

    返回 (Popen, stderr 临时文件路径)。stderr 落文件而不是 PIPE:
      - 避免 ffmpeg 输出较多时写满 OS 管道缓冲 (~64KB) 把进程永久阻塞;
      - 解码出错时能读回真实诊断, 而不是静默得到 0 帧。
    调用方负责 wait/回收, 并在结束后删除该临时文件。

    输出帧率:
      raw/single -> 源帧率; double -> 2x 源帧率。
    时间戳由调用方依据 ffprobe 的真实 pts 与场模型计算, 不在这里猜。
    """
    exe = find_executable("ffmpeg")
    vf = build_video_filter(mode, parity)
    cmd = [
        exe, "-hide_banner", "-loglevel", "error",
        "-i", str(path),
        "-vf", vf,
        "-pix_fmt", pix_fmt,
        "-fps_mode", "passthrough",
        "-f", "rawvideo",
        "pipe:1",
    ]
    import tempfile
    stderr_fh = tempfile.NamedTemporaryFile(
        prefix="dlab_ffmpeg_", suffix=".log", delete=False
    )
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=stderr_fh)
    stderr_fh.close()
    return proc, Path(stderr_fh.name)


def read_stderr_log(path: str | Path, limit: int = 2000) -> str:
    try:
        return Path(path).read_text(errors="replace")[-limit:].strip()
    except OSError:
        return ""


def frame_size(width: int, height: int, pix_fmt: str = "rgb24") -> int:
    bytes_per_pixel = {"rgb24": 3, "rgba": 4, "gray": 1}[pix_fmt]
    return width * height * bytes_per_pixel


def export_deinterlaced(
    src: str | Path,
    dst: str | Path,
    mode: str,
    parity: str,
    *,
    on_progress=None,
) -> None:
    """导出单倍或双倍去隔行成品, 保持源速度/尺寸/音频, 标记为逐行。

    音频优先直接 stream copy, 容器不兼容时回退 AAC 重新编码。
    视频用 yadif 后显式 setparams=field_mode=prog 标记逐行。
    """
    if mode not in ("single", "double"):
        raise ValueError("导出只支持 single / double")
    exe = find_executable("ffmpeg")
    vf = build_video_filter(mode, parity) + ",setparams=field_mode=prog"
    src = Path(src)
    dst = Path(dst)

    # 先尝试音频直接拷贝; 失败则重编码音频。
    base = [
        exe, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-vf", vf,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
    ]
    cmd_copy = [*base, "-c:a", "copy", "-fps_mode", "passthrough", str(dst)]
    proc = subprocess.run(cmd_copy, capture_output=True, text=True)
    if proc.returncode != 0:
        cmd_aac = [*base, "-c:a", "aac", "-b:a", "192k",
                   "-fps_mode", "passthrough", str(dst)]
        proc = subprocess.run(cmd_aac, capture_output=True, text=True)
        if proc.returncode != 0:
            raise FFmpegError(
                f"导出失败:\n{proc.stderr.strip()}"
            )
    if on_progress is not None:
        on_progress(1.0)


def read_exported_pts(path: str | Path) -> list[float]:
    """读取成品的真实逐帧 pts, 供验证使用。"""
    frames = ffprobe_json(
        path,
        [
            "-select_streams", "v:0",
            "-show_frames",
            "-show_entries", "frame=pts_time,interlaced_frame",
            "-print_format", "json",
        ],
    ).get("frames", [])
    pts = [float(f["pts_time"]) for f in frames if f.get("pts_time") not in (None, "N/A")]
    interlaced = any(f.get("interlaced_frame") == 1 for f in frames)
    return pts, interlaced, len(frames)
