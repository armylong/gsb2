"""三路对照生成管线。

流程 (外部输入与内置样例共用):
  RGB 帧 -> BT.709 limited YUV (本包 numpy) -> 4:4:4 / 4:2:2 / 4:2:0 下采样
        -> planar 原始流 -> FFV1/MKV 无损编码 -> 解码回读字节级核对

预览与测量一律读取 *回读确认后* 的 planar 数据; 编码产物被替换或核对失败时,
Project.probe 中带明确警告, UI 不显示任何"预期格式"冒充实际格式。
"""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import ffmpeg_tools as ff
from .color import (
    CHROMA_LOCATION,
    MODES,
    PIXEL_FORMATS,
    plane_dims,
    rgb_to_yuv,
    subsample,
)
from .pattern import generate_pattern

RAW_SUFFIX = ".yuv"
VIDEO_SUFFIX = "." + ff.CONTAINER_EXT


@dataclass
class Variant:
    mode: str                       # 444 / 422 / 420
    pix_fmt: str                    # 实际编码像素格式 (回读后填入)
    width: int
    height: int
    chroma_width: int
    chroma_height: int
    raw_path: Path                  # 本工具生成的 planar 原始流
    verified_raw_path: Path         # 从 MKV 解码回读的 planar (核对一致后用于预览)
    video_path: Path                # FFV1/MKV 成品
    probe: ff.ProbeResult
    chroma_location: str


@dataclass
class Project:
    workdir: Path
    source_label: str               # 输入文件名或 "内置样例"
    is_synthetic: bool
    width: int
    height: int
    fps: float
    fps_fraction: str
    frame_count: int
    frame_times: np.ndarray         # 每帧实际时间 (秒)
    rgb_frames: np.ndarray          # [N,H,W,3] uint8, 外部解码或样例生成
    variants: dict[str, Variant]
    warnings: list[str] = field(default_factory=list)

    # ------------------------------------------------------------ 查询
    def duration(self) -> float:
        return float(self.frame_times[-1] + 1.0 / self.fps) if self.frame_count else 0.0

    def time_of(self, index: int) -> float:
        if 0 <= index < len(self.frame_times):
            return float(self.frame_times[index])
        return index / self.fps

    def frame_at_time(self, t: float) -> int:
        if self.frame_count == 0:
            return 0
        return int(np.clip(np.searchsorted(self.frame_times, t, side="left"), 0, self.frame_count - 1))

    def get_planes(self, index: int, mode: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """从 *回读核对过* 的 planar 文件取第 index 帧 Y/Cb/Cr。"""
        v = self.variants[mode]
        return ff.read_planar_frame(v.verified_raw_path, self.width, self.height, mode, index)

    def all_planes(self, mode: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        ys, cbs, crs = [], [], []
        for i in range(self.frame_count):
            y, cb, cr = self.get_planes(i, mode)
            ys.append(y)
            cbs.append(cb)
            crs.append(cr)
        return np.stack(ys), np.stack(cbs), np.stack(crs)

    def export(self, out_dir: str | Path) -> dict[str, Path]:
        """把三份成品复制到用户目录并再次回读核对, 返回 {mode: 路径}。"""
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        result: dict[str, Path] = {}
        for mode in MODES:
            v = self.variants[mode]
            dst = out_dir / f"{self._stem()}_{mode}{VIDEO_SUFFIX}"
            shutil.copy2(v.video_path, dst)
            recheck = ff.verify_export(
                dst, mode, self.width, self.height,
                self.frame_count, self.fps_fraction, self.duration(),
            )
            if not recheck.ok:
                raise ff.FFmpegError(f"导出回读核对失败 {dst.name}: " + "; ".join(recheck.warnings))
            result[mode] = dst
        return result

    def _stem(self) -> str:
        raw = "synthetic" if self.is_synthetic else Path(self.source_label).stem
        return "".join(c if c.isalnum() or c in "-_." else "_" for c in raw)[:40]


# ------------------------------------------------------------ 构建

def _write_planar(path: Path, y: np.ndarray, cb: np.ndarray, cr: np.ndarray) -> None:
    with open(path, "wb") as fh:
        for plane in (y, cb, cr):
            fh.write(np.ascontiguousarray(plane).tobytes())


def _build_variants(workdir: Path, rgb_frames: np.ndarray,
                    width: int, height: int, fps_fraction: str) -> dict[str, Variant]:
    n = rgb_frames.shape[0]

    # 1) RGB -> 4:4:4 YUV (三路共用同一份 Y 与同一份全尺寸色度)
    y444 = np.empty((n, height, width), np.uint8)
    cb444 = np.empty_like(y444)
    cr444 = np.empty_like(y444)
    for i, rgb in enumerate(rgb_frames):
        y444[i], cb444[i], cr444[i] = rgb_to_yuv(rgb)

    variants: dict[str, Variant] = {}
    for mode in MODES:
        cw, ch = plane_dims(mode, width, height)
        raw_path = workdir / f"{mode}{RAW_SUFFIX}"
        verified_path = workdir / f"{mode}_verified{RAW_SUFFIX}"
        video_path = workdir / f"{mode}{VIDEO_SUFFIX}"

        cb_sub = np.empty((n, ch, cw), np.uint8)
        cr_sub = np.empty((n, ch, cw), np.uint8)
        with open(raw_path, "wb") as fh:
            for i in range(n):
                cb_i = subsample(cb444[i], mode)
                cr_i = subsample(cr444[i], mode)
                cb_sub[i], cr_sub[i] = cb_i, cr_i
                fh.write(np.ascontiguousarray(y444[i]).tobytes())
                fh.write(np.ascontiguousarray(cb_i).tobytes())
                fh.write(np.ascontiguousarray(cr_i).tobytes())

        # 2) FFV1 无损封装 (带明示颜色标签与采样位置)
        ff.encode_ffv1(raw_path, video_path, width, height, mode, fps_fraction)

        # 3) 解码回读, 与送编码的原始流逐字节核对
        proc = ff._run([
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(video_path),
            "-f", "rawvideo", "-pix_fmt", PIXEL_FORMATS[mode], "-",
        ])
        src_bytes = raw_path.read_bytes()
        if proc.stdout != src_bytes:
            raise ff.FFmpegError(
                f"{mode}: FFV1 回读数据与编码输入不一致 —— 编码并非无损, 已中止"
            )
        verified_path.write_bytes(proc.stdout)

        # 4) ffprobe 元数据核对 (实际格式, 不是预期格式)
        probe = ff.verify_export(
            video_path, mode, width, height, n, fps_fraction,
            expected_duration_s=n / _fraction_to_fps(fps_fraction),
        )

        variants[mode] = Variant(
            mode=mode,
            pix_fmt=probe.actual.get("pix_fmt", PIXEL_FORMATS[mode]),
            width=width,
            height=height,
            chroma_width=cw,
            chroma_height=ch,
            raw_path=raw_path,
            verified_raw_path=verified_path,
            video_path=video_path,
            probe=probe,
            chroma_location=CHROMA_LOCATION[mode],
        )
    return variants


def _fraction_to_fps(frac: str) -> float:
    num, den = frac.split("/")
    return float(num) / float(den)


def _frame_times_from_pts(pts: list[float], count: int, fps: float) -> tuple[np.ndarray, list[str]]:
    warns: list[str] = []
    if len(pts) == count:
        times = np.array(pts, dtype=np.float64)
    else:
        if pts:
            warns.append(f"PTS 包数 ({len(pts)}) 与解码帧数 ({count}) 不一致, 时间轴按 {fps:g}fps 等距回退")
        times = np.arange(count, dtype=np.float64) / fps
    return times, warns


def build_from_input(video_path: str | Path, workdir: str | Path | None = None) -> Project:
    """从外部视频构建三路对照 (4:4:4 仅为当前解码基准, 见 README 说明)。"""
    ff.ensure_tools()
    video_path = Path(video_path)
    info = ff.validate_input(video_path)
    rgb_frames, pts = ff.read_rgb24(video_path, info.even_width, info.even_height)
    times, warns = _frame_times_from_pts(pts, len(rgb_frames), info.fps)

    workdir = Path(workdir or tempfile.mkdtemp(prefix="chromasub_"))
    workdir.mkdir(parents=True, exist_ok=True)
    variants = _build_variants(workdir, rgb_frames, info.even_width, info.even_height, info.fps_fraction)

    return Project(
        workdir=workdir,
        source_label=video_path.name,
        is_synthetic=False,
        width=info.even_width,
        height=info.even_height,
        fps=info.fps,
        fps_fraction=info.fps_fraction,
        frame_count=len(rgb_frames),
        frame_times=times,
        rgb_frames=rgb_frames,
        variants=variants,
        warnings=warns,
    )


def generate_synthetic(workdir: str | Path | None = None,
                       width: int = 640, height: int = 480,
                       frame_count: int = 60, fps: int = 30) -> Project:
    """生成内置测试样例并构建三路对照。"""
    ff.ensure_tools()
    if frame_count / fps > 5.0 + 1e-6:
        raise ValueError("内置样例不超过 5 秒")
    rgb_frames = generate_pattern(width, height, frame_count, fps)
    fps_fraction = f"{fps}/1"
    times = np.arange(frame_count, dtype=np.float64) / fps

    workdir = Path(workdir or tempfile.mkdtemp(prefix="chromasub_syn_"))
    workdir.mkdir(parents=True, exist_ok=True)
    variants = _build_variants(workdir, rgb_frames, width, height, fps_fraction)

    return Project(
        workdir=workdir,
        source_label="内置样例",
        is_synthetic=True,
        width=width,
        height=height,
        fps=float(fps),
        fps_fraction=fps_fraction,
        frame_count=frame_count,
        frame_times=times,
        rgb_frames=rgb_frames,
        variants=variants,
        warnings=[],
    )
