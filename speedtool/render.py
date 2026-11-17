"""ffmpeg 分段变速渲染管线。

保证时长精度的做法：
  - 输出固定 30fps。每段目标帧数按“累计输出时间四舍五入到帧”的差值计算，
    因此总帧数 == round(预计总时长 * 30)，与预计值差距不超过半个输出帧。
  - 视频链：trim -> setpts(PTS/速度) -> fps=30 -> tpad(克隆尾帧) -> trim=end_frame，
    不足补尾帧、超出裁掉，逐段帧数严格等于目标值。
  - 音频链：atrim -> atempo(保调变速) -> aresample=48k -> apad -> atrim=end_sample，
    逐段采样数同样按累计值取齐，音视频尾部对齐在一个输出帧（1/30s）以内。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .segments import PlanRow

FPS = 30
SAMPLE_RATE = 48000


def probe(path: str | Path) -> dict:
    """ffprobe 读取时长/流信息。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(out.stdout)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        raise ValueError("文件中没有视频流")
    duration = float(info["format"]["duration"])
    num, den = v.get("avg_frame_rate", "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    return {
        "duration": duration,
        "has_audio": a is not None,
        "fps": fps,
        "width": int(v.get("width", 0)),
        "height": int(v.get("height", 0)),
        "audio_duration": float(a["duration"]) if a and "duration" in a else None,
    }


def frame_counts(plan: list[PlanRow]) -> list[int]:
    """每段输出帧数：累计输出时间四舍五入到帧后取差值。"""
    counts, prev = [], 0
    for row in plan:
        cum = round(row.out_end * FPS)
        counts.append(cum - prev)
        prev = cum
    return counts


def sample_counts(plan: list[PlanRow]) -> list[int]:
    """每段输出音频采样数（48kHz），与帧数同一套累计取齐逻辑。"""
    counts, prev = [], 0
    for row in plan:
        cum = round(row.out_end * SAMPLE_RATE)
        counts.append(cum - prev)
        prev = cum
    return counts


def build_filter(plan: list[PlanRow]) -> str:
    fc = frame_counts(plan)
    sc = sample_counts(plan)
    parts: list[str] = []
    for i, row in enumerate(plan):
        s, e, v = row.src_start, row.src_end, row.speed
        parts.append(
            f"[0:v]trim=start={s:.6f}:end={e:.6f},"
            f"setpts=(PTS-STARTPTS)/{v:.8f},"
            f"fps={FPS},"
            f"tpad=stop=-1:stop_mode=clone,"
            f"trim=end_frame={fc[i]},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
        parts.append(
            f"[0:a]atrim=start={s:.6f}:end={e:.6f},"
            f"asetpts=PTS-STARTPTS,"
            f"atempo={v:.8f},"
            f"aresample={SAMPLE_RATE},"
            f"apad,"
            f"atrim=end_sample={sc[i]},"
            f"asetpts=PTS-STARTPTS[a{i}]"
        )
    ins = "".join(f"[v{i}][a{i}]" for i in range(len(plan)))
    parts.append(f"{ins}concat=n={len(plan)}:v=1:a=1[v][a]")
    return ";".join(parts)


def render(input_path: str | Path, plan: list[PlanRow], output_path: str | Path,
           crf: int = 18) -> dict:
    """渲染变速视频，返回输出文件的 probe 信息。"""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-filter_complex", build_filter(plan),
        "-map", "[v]", "-map", "[a]",
        "-r", str(FPS),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", str(crf), "-preset", "medium",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 渲染失败:\n{proc.stderr[-3000:]}")
    return probe(output_path)
