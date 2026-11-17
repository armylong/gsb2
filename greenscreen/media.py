"""素材读取与元数据探测。

优先使用系统 ffmpeg/ffprobe；找不到时回退到 imageio-ffmpeg 自带的二进制。
OpenCV 只负责逐帧解码。所有“打不开 / 没有画面 / 格式不支持”的情况都
抛出带中文说明的 :class:`MediaError`，绝不静默返回空数据。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import MediaError

# 图像/视频允许的扩展名（明确拒绝其它后缀，给用户清晰提示）
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".mpg", ".mpeg"}


def find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def find_ffprobe() -> str | None:
    return shutil.which("ffprobe")


def ensure_supported(path: str | Path, kind: str) -> Path:
    """检查文件存在且扩展名受支持，kind 为 'video' 或 'image'。"""
    p = Path(path)
    if not p.exists():
        raise MediaError(f"找不到文件：{p}")
    if not p.is_file():
        raise MediaError(f"这不是一个文件：{p}")
    ext = p.suffix.lower()
    allowed = VIDEO_EXTS if kind == "video" else IMAGE_EXTS
    if ext not in allowed:
        allow_text = "、".join(sorted(allowed))
        raise MediaError(
            f"不支持的{('视频' if kind == 'video' else '图片')}格式 {ext or '(无扩展名)'}，"
            f"支持的格式：{allow_text}"
        )
    return p


def load_image(path: str | Path) -> np.ndarray:
    """读取静态背景图为 BGR uint8。"""
    p = ensure_supported(path, "image")
    # imread 不支持中文路径时用 fromfile + imdecode 兜底
    img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        img = cv2.imread(str(p), cv2.IMREAD_COLOR)
    if img is None or img.size == 0:
        raise MediaError(f"背景图无法解码，文件可能已损坏：{p.name}")
    return img


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    has_audio: bool
    audio_streams: list[dict]


def _probe_with_ffprobe(path: Path) -> dict | None:
    ffprobe = find_ffprobe()
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [
                ffprobe, "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", str(path),
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return json.loads(out.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def probe_video(path: str | Path) -> VideoInfo:
    """用 ffprobe 探测尺寸/帧率/时长/音轨；无 ffprobe 时退回 OpenCV。"""
    p = ensure_supported(path, "video")
    meta = _probe_with_ffprobe(p)

    width = height = 0
    fps = 0.0
    frame_count = 0
    duration = 0.0
    audio_streams: list[dict] = []

    if meta:
        for st in meta.get("streams", []):
            if st.get("codec_type") == "video" and width == 0:
                width = int(st.get("width", 0))
                height = int(st.get("height", 0))
                num = eval_fraction(st.get("avg_frame_rate") or st.get("r_frame_rate"))
                fps = num
                fc = st.get("nb_frames")
                if fc and str(fc).isdigit():
                    frame_count = int(fc)
            elif st.get("codec_type") == "audio":
                audio_streams.append(
                    {"index": st.get("index"), "codec": st.get("codec_name")}
                )
        try:
            duration = float(meta.get("format", {}).get("duration", 0.0))
        except (TypeError, ValueError):
            duration = 0.0

    # OpenCV 兜底 / 补全
    cap = cv2.VideoCapture(str(p))
    if not cap.isOpened():
        raise MediaError(f"视频无法打开，编码可能不受支持：{p.name}")
    if not width:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    if not height:
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not fps:
        fps = cap.get(cv2.CAP_PROP_FPS)
    if not frame_count:
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    if width <= 0 or height <= 0:
        raise MediaError(f"视频里没有可显示的画面：{p.name}")
    if not fps or fps <= 0 or not np.isfinite(fps):
        fps = 25.0  # 元数据缺失时给一个安全默认值
    if frame_count <= 0:
        if duration > 0:
            frame_count = int(round(duration * fps))
        else:
            raise MediaError(f"无法确定视频帧数，素材可能已损坏：{p.name}")
    if duration <= 0:
        duration = frame_count / fps

    return VideoInfo(
        width=width, height=height, fps=float(fps),
        frame_count=frame_count, duration=float(duration),
        has_audio=bool(audio_streams), audio_streams=audio_streams,
    )


def eval_fraction(text: str | None) -> float:
    """解析 ffprobe 的 '30000/1001' 形式帧率。"""
    if not text or text in ("0/0", "N/A"):
        return 0.0
    try:
        if "/" in text:
            num, den = text.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else 0.0
        return float(text)
    except ValueError:
        return 0.0


class VideoReader:
    """可随机定位的视频帧读取器，拖动时间轴时按帧号精确跳转。"""

    def __init__(self, path: str | Path):
        self.path = ensure_supported(path, "video")
        self.info = probe_video(self.path)
        self._cap = cv2.VideoCapture(str(self.path))
        if not self._cap.isOpened():
            raise MediaError(f"视频无法打开，编码可能不受支持：{self.path.name}")
        self._index = -1

    @property
    def frame_count(self) -> int:
        return self.info.frame_count

    @property
    def fps(self) -> float:
        return self.info.fps

    def read_frame(self, index: int) -> np.ndarray:
        """读取指定帧号（0 起），越界返回 None。"""
        if index < 0 or index >= self.info.frame_count:
            return None
        if index != self._index + 1:
            # 非顺序读取时显式 seek，保证拖时间轴后画面精确
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = self._cap.read()
        if not ok or frame is None:
            # 个别编码 seek 不精确，回退到再 seek 重读一次
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = self._cap.read()
        if not ok or frame is None:
            raise MediaError(
                f"第 {index + 1} 帧读取失败，视频可能已损坏：{self.path.name}"
            )
        self._index = index
        return frame

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "VideoReader":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
