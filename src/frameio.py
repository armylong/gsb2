"""Decoding, sample discovery and ffmpeg export.

Preview decoding happens once, at a reduced scale, into a contiguous numpy
array so scrubbing and windowed filtering are instant.  Export re-decodes at
full resolution and streams frames through ffmpeg, muxing the original audio
track so timing and sound survive the round trip.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

import analysis
import sample_common as C
import sample_gen


class SequenceError(RuntimeError):
    pass


class Sequence:
    """A clip decoded to RAM. Indexable like a frame source."""

    def __init__(self, frames: np.ndarray, fps: float, path: Path, scale: float):
        if frames.ndim not in (3, 4):
            raise SequenceError(f"expected (T,H,W[,C]), got {frames.shape}")
        self.frames = frames
        self.fps = fps
        self.path = path
        self.scale = scale

    def __len__(self) -> int:
        return int(self.frames.shape[0])

    @property
    def size(self) -> tuple[int, int]:
        return int(self.frames.shape[2]), int(self.frames.shape[1])

    def read(self, index: int) -> np.ndarray | None:
        if 0 <= index < len(self):
            return self.frames[index]
        return None

    def shape(self) -> tuple[int, int, int]:
        return self.frames.shape[1:]


def _video_meta(path: Path) -> tuple[int, float, int, int]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise SequenceError(f"cannot open {path}")
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or C.FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    if count <= 0:
        raise SequenceError(f"{path} reports no frames")
    return count, fps, w, h


def load_sequence(path: Path, scale: float = 0.5, gray: bool = False) -> Sequence:
    count, fps, w, h = _video_meta(path)
    cap = cv2.VideoCapture(str(path))
    frames: list[np.ndarray] = []
    out_size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if gray:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if out_size != (w, h):
            frame = cv2.resize(frame, out_size, interpolation=cv2.INTER_AREA)
        frames.append(np.ascontiguousarray(frame))
        if len(frames) > count:
            break
    cap.release()
    if not frames:
        raise SequenceError(f"decoded no frames from {path}")
    # Some containers report a stale/rounded frame count; trust what decoded.
    return Sequence(np.stack(frames, axis=0), fps, path, scale)


def has_audio(path: Path) -> bool:
    if not shutil.which("ffprobe"):
        return False
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_type", "-of", "csv", str(path)],
        capture_output=True, text=True)
    return "audio" in out.stdout


def write_sample(out_dir: Path, progress=None) -> dict:
    """Generate the sample (delegates to sample_gen) and return its manifest."""
    if progress:
        progress("正在生成静止纹理 + 移动小物体 + 镜头切换样例…")
    manifest = sample_gen.generate(out_dir)
    if progress:
        progress(f"样例已写入 {out_dir}")
    return manifest


def load_bundle(root: Path, scale: float = 0.5) -> dict:
    """Load the generated sample into memory, including clean/mask references."""
    root = Path(root)
    manifest_path = root / C.MANIFEST_NAME
    if not manifest_path.exists():
        raise SequenceError(f"样例不存在: {root}\n请先点击『生成样例』或运行 python src/sample_gen.py")
    manifest = json.loads(manifest_path.read_text())
    original = load_sequence(root / C.ORIGINAL_NAME, scale=scale)
    clean = load_sequence(root / C.CLEAN_NAME, scale=scale)
    mask_path = root / C.MASK_NAME
    mask = load_sequence(mask_path, scale=scale, gray=True) if mask_path.exists() else None
    if len(clean) != len(original):
        raise SequenceError("clean reference and original differ in length")
    return {
        "manifest": manifest,
        "original": original,
        "clean": clean,
        "mask": mask,
        "root": root,
    }


# --------------------------------------------------------------- export


class _ForwardReader:
    """Forward-only decoder with a small window buffer, for full-res export."""

    def __init__(self, path: Path):
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise SequenceError(f"cannot open {path}")
        self.next_index = 0
        self.frames: dict[int, np.ndarray] = {}

    def get(self, index: int, keep_from: int) -> np.ndarray:
        while self.next_index <= index:
            ok, frame = self.cap.read()
            if not ok:
                raise SequenceError(f"decoder ended at {self.next_index}, need {index}")
            self.frames[self.next_index] = frame
            self.next_index += 1
        for old in [k for k in self.frames if k < keep_from]:
            del self.frames[old]
        return self.frames[index]

    def close(self) -> None:
        self.cap.release()


def export_video(bundle: dict, shots: list[analysis.Shot], params: analysis.Params,
                 mode: str, out_path: Path, progress=None) -> Path:
    """Filter every frame and write an mp4 that keeps the source audio.

    ``mode`` is ``orig``, ``mean`` or ``atten``.  ``orig`` is a plain remux/encode
    with no temporal processing, useful as a control.
    """
    if mode not in {"orig", "mean", "atten"}:
        raise ValueError(f"unknown export mode {mode!r}")
    root: Path = bundle["root"]
    src_path = root / C.ORIGINAL_NAME
    if not src_path.exists():
        raise SequenceError(f"missing {src_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    count, fps, width, height = _video_meta(src_path)
    fps_str = f"{fps:g}"
    reader = _ForwardReader(src_path)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}",
        "-framerate", fps_str, "-i", "pipe:0",
    ]
    audio_src = root / C.AUDIO_NAME if (root / C.AUDIO_NAME).exists() else src_path
    if has_audio(audio_src):
        cmd += ["-i", str(audio_src)]
    cmd += ["-map", "0:v:0"]
    if has_audio(audio_src):
        cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "16",
        "-pix_fmt", "yuv420p", "-r", fps_str, "-movflags", "+faststart",
    ]
    if has_audio(audio_src):
        cmd += ["-shortest"]
    cmd += [str(out_path)]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    cancelled = False
    try:
        for i in range(count):
            shot = analysis.shot_at(i, shots)
            window = analysis.window_for(i, shot, params.radius)
            if mode == "orig" or window.degraded:
                write = reader.get(i, keep_from=max(0, i - params.radius))
            else:
                stack = np.stack([reader.get(j, keep_from=window.frames[0])
                                  for j in window.frames])
                mean, atten, _, _ = analysis.filter_stack(
                    stack, window.frames.index(i), params)
                write = mean if mode == "mean" else atten
            proc.stdin.write(np.ascontiguousarray(write).tobytes())
            if progress and count:
                # A progress callback returning False asks to abort.
                if progress(i / count) is False:
                    cancelled = True
                    break
        try:
            proc.stdin.close()
        except BrokenPipeError:
            cancelled = True
        rc = proc.wait()
        if cancelled:
            out_path.unlink(missing_ok=True)
            raise SequenceError("export cancelled")
        if rc != 0:
            raise SequenceError(f"ffmpeg exited with {rc}")
    finally:
        reader.close()
    return out_path
