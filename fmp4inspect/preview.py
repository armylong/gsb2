"""用 ffmpeg/ffprobe 验证片段的实际可解码区域."""
from __future__ import annotations

import json
import os
import struct
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from .model import Presentation, Segment


@dataclass
class StreamDecode:
    codec_type: str                 # 'video' | 'audio'
    frame_pts: List[float] = field(default_factory=list)   # 实际解码出的帧 PTS (秒)
    keyframes: List[bool] = field(default_factory=list)
    nb_samples: List[int] = field(default_factory=list)    # 音频每帧样本数

    @property
    def frame_count(self) -> int:
        return len(self.frame_pts)

    @property
    def pts_range(self) -> Optional[Tuple[float, float]]:
        if not self.frame_pts:
            return None
        return min(self.frame_pts), max(self.frame_pts)


@dataclass
class PreviewResult:
    tmp_path: str
    video: Optional[StreamDecode] = None
    audio: Optional[StreamDecode] = None
    thumbnails: List[Tuple[float, str]] = field(default_factory=list)  # (pts, png路径)
    pcm: Optional[bytes] = None        # 单声道 8kHz s16le
    pcm_rate: int = 8000
    audio_peak: float = 0.0
    audio_rms: float = 0.0
    errors: List[str] = field(default_factory=list)


def _run(cmd: List[str], check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, check=check)


def concat_to_temp(pres: Presentation, segs: List[Segment], tmpdir: str) -> str:
    """把 init + 给定片段拼成一个临时 fmp4 供解码."""
    out = os.path.join(tmpdir, "concat.mp4")
    with open(out, "wb") as f:
        f.write(pres.read_init_bytes())
        for s in segs:
            f.write(pres.read_segment_bytes(s))
    return out


def probe_frames(path: str, stream: str) -> Optional[StreamDecode]:
    """stream: 'v:0' 或 'a:0'. 返回实际解码出的帧信息."""
    r = _run(["ffprobe", "-v", "error", "-select_streams", stream,
              "-show_frames", "-of", "json", path])
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return None
    sd = StreamDecode(codec_type="video" if stream.startswith("v") else "audio")
    for fr in data.get("frames", []):
        pts = fr.get("pts_time", fr.get("pkt_pts_time"))
        if pts is None:
            continue
        sd.frame_pts.append(float(pts))
        sd.keyframes.append(bool(fr.get("key_frame", 0)))
        if "nb_samples" in fr:
            sd.nb_samples.append(int(fr["nb_samples"]))
    return sd


def decode_preview(pres: Presentation, seg: Segment,
                   max_thumbs: int = 24) -> PreviewResult:
    """解码单个片段 (init + 该片段), 返回实际可解码区域."""
    tmpdir = tempfile.mkdtemp(prefix="fmp4prev_")
    result = PreviewResult(tmp_path=tmpdir)
    try:
        concat = concat_to_temp(pres, [seg], tmpdir)
    except ValueError as e:
        result.errors.append(str(e))
        return result

    has_video = any(t.handler == "vide" for t in pres.tracks.values())
    has_audio = any(t.handler == "soun" for t in pres.tracks.values())

    if has_video:
        result.video = probe_frames(concat, "v:0")
        if result.video and result.video.frame_count:
            step = max(1, result.video.frame_count // max_thumbs)
            outpat = os.path.join(tmpdir, "thumb_%03d.png")
            _run(["ffmpeg", "-y", "-v", "error", "-i", concat,
                  "-map", "0:v:0", "-vf",
                  f"select='not(mod(n\\,{step}))',scale=192:-2",
                  "-fps_mode", "passthrough", "-frames:v", str(max_thumbs),
                  outpat])
            thumbs = sorted(f for f in os.listdir(tmpdir) if f.startswith("thumb_"))
            pts = result.video.frame_pts[::step]
            for i, t in enumerate(thumbs):
                p = pts[i] if i < len(pts) else (pts[-1] if pts else 0.0)
                result.thumbnails.append((p, os.path.join(tmpdir, t)))

    if has_audio:
        result.audio = probe_frames(concat, "a:0")
        r = _run(["ffmpeg", "-v", "error", "-i", concat,
                  "-map", "0:a:0", "-ac", "1", "-ar", str(result.pcm_rate),
                  "-f", "s16le", "pipe:1"])
        if r.returncode == 0 and r.stdout:
            result.pcm = r.stdout
            n = len(r.stdout) // 2
            samples = struct.unpack(f"<{n}h", r.stdout[: n * 2])
            if n:
                result.audio_peak = max(abs(s) for s in samples) / 32768.0
                result.audio_rms = (sum(s * s for s in samples) / n) ** 0.5 / 32768.0
    return result
