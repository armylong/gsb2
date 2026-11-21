"""ffprobe 封装: 读取素材参数、内嵌时间码, 并检测是否恒定帧率."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction


class ProbeError(RuntimeError):
    pass


@dataclass
class MediaInfo:
    path: str
    width: int
    height: int
    pix_fmt: str
    fps: Fraction            # 实际帧率 (r_frame_rate)
    nb_frames: int | None    # 总帧数, 读不到则为 None
    duration: float | None   # 秒
    embedded_timecode: str | None  # 内嵌时间码 (若有)
    is_cfr: bool             # 是否恒定帧率
    vfr_note: str | None     # 非恒定帧率时的说明

    @property
    def frame_count(self) -> int | None:
        if self.nb_frames is not None:
            return self.nb_frames
        if self.duration is not None:
            return int(round(self.duration * float(self.fps)))
        return None


def _run_ffprobe(args: list[str]) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json"] + args
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except FileNotFoundError:
        raise ProbeError("找不到 ffprobe, 请先安装 ffmpeg")
    except subprocess.CalledProcessError as e:
        raise ProbeError(f"ffprobe 失败: {e.stderr.strip()}")
    return json.loads(out.stdout or "{}")


def _fraction(s: str | None) -> Fraction | None:
    if not s or s in ("0/0", "N/A"):
        return None
    try:
        return Fraction(s)
    except (ValueError, ZeroDivisionError):
        return None


def probe(path: str) -> MediaInfo:
    data = _run_ffprobe(["-show_format", "-show_streams", path])
    vstreams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    if not vstreams:
        raise ProbeError("文件里没有视频流")
    vs = vstreams[0]

    fps = _fraction(vs.get("r_frame_rate")) or _fraction(vs.get("avg_frame_rate"))
    if not fps:
        raise ProbeError("读不到帧率")
    avg = _fraction(vs.get("avg_frame_rate"))

    # 内嵌时间码: 优先视频流 tags, 其次容器 format tags, 再其次独立的 timecode 数据流
    tc = (vs.get("tags") or {}).get("timecode") or (data.get("format", {}).get("tags") or {}).get("timecode")
    if not tc:
        for s in data.get("streams", []):
            if s.get("codec_tag_string") == "tmcd" or (s.get("codec_type") == "data" and (s.get("tags") or {}).get("timecode")):
                tc = (s.get("tags") or {}).get("timecode")
                break

    nb_frames = None
    if vs.get("nb_frames") and vs["nb_frames"] != "N/A":
        nb_frames = int(vs["nb_frames"])
    duration = None
    for d in (vs.get("duration"), data.get("format", {}).get("duration")):
        if d and d != "N/A":
            duration = float(d)
            break

    # 恒定帧率判定: r_frame_rate 与 avg_frame_rate 一致, 且抽样包时长一致
    is_cfr = True
    note = None
    if avg and fps and abs(float(fps) - float(avg)) > 1e-6:
        is_cfr = False
        note = f"r_frame_rate={fps} 与 avg_frame_rate={avg} 不一致"
    if is_cfr:
        pkts = _run_ffprobe([
            "-select_streams", "v:0",
            "-read_intervals", "%+3",
            "-show_entries", "packet=duration",
            "-of", "json", path,
        ]).get("packets", [])
        durs = {p.get("duration") for p in pkts if p.get("duration") is not None}
        if len(durs) > 1:
            is_cfr = False
            note = f"抽样包时长不一致: {sorted(durs)[:5]}"

    if not is_cfr:
        note = (note or "帧间隔不恒定") + "。本工具按恒定帧率换算帧号与时间码, 目前仅适用于恒定帧率(CFR)素材, 该文件的对位结果不可靠。"

    return MediaInfo(
        path=path,
        width=int(vs["width"]),
        height=int(vs["height"]),
        pix_fmt=vs.get("pix_fmt", "unknown"),
        fps=fps,
        nb_frames=nb_frames,
        duration=duration,
        embedded_timecode=tc,
        is_cfr=is_cfr,
        vfr_note=note,
    )
