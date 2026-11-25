"""从解码后的画面/声音里独立识别标记, 再与计划对齐.

识别阶段 (analyze_film) 完全不读取 plan:
* 画面标记: 按"整帧高亮度 + 顶部 10 段黑白编码"检出;
  同一编号、间隔极短的重复帧会被合并, 不当作第二次闪光.
* 声音标记: 按短时能量检出短促的提示声, 再用 Goertzel 在 16 个候选音高
  上定编号.

匹配阶段 (match_plan) 才把独立检出的结果与计划时刻对齐, 并区分:
* 整体偏移 (某个通道所有事件都平移了)
* 个别事件问题 (扣掉整体偏移后仍有残差, 或多出/缺失的事件)
"""

from __future__ import annotations

import math
import os
import statistics
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import model
from .model import AudioDetection, VideoDetection

DECODE_W = model.DETECT_VIDEO_WIDTH
DECODE_H = model.DETECT_VIDEO_HEIGHT

FLASH_LUMA_MIN = 150.0          # 闪光帧平均亮度阈值 (0..255)
FLASH_BRIGHT_FRACTION = 0.55    # 亮度 > 190 的像素占比阈值
MERGE_GAP_FRAMES = 4            # 同编号两次闪光之间的帧间隔 <= 此值视为重复帧
MERGE_MAX_DUP_FRAMES = 2        # 被合并的那一小段最多几帧

AUDIO_RMS_THRESHOLD_FLOOR = 0.012
AUDIO_MERGE_GAP_S = 0.025
TONE_FREQ_TOL_HZ = 45.0


def _origin_time(probe: dict[str, Any]) -> float:
    """全片的时间零点: 第一帧画面的容器时刻.

    这样 "计划时刻 0" 就对应片子的第一帧, 即使封装文件整体不从 0 开始也一样.
    """
    vin = probe.get("video") or {}
    if vin.get("start_time") is not None:
        return float(vin["start_time"])
    return float(probe.get("start_time") or 0.0)


def _which(name: str) -> str:
    exe = None
    try:
        import shutil

        exe = shutil.which(name)
    except Exception:  # pragma: no cover
        exe = None
    if not exe:
        raise RuntimeError(f"找不到 {name}, 请先安装 ffmpeg 并确保在 PATH 中")
    return exe


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------


def probe_film(path: str) -> dict[str, Any]:
    cmd = [
        _which("ffprobe"), "-v", "error", "-show_streams", "-show_format",
        "-of", "json", path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe 读取失败: {proc.stderr.strip()[-800:]}")
    import json

    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    vid = next((s for s in streams if s.get("codec_type") == "video"), None)
    aud = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})

    def _f(v, default=None):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    info: dict[str, Any] = {
        "path": os.path.abspath(path),
        "format_name": fmt.get("format_name"),
        "duration": _f(fmt.get("duration")),
        "start_time": _f(fmt.get("start_time"), 0.0),
        "video": None,
        "audio": None,
    }
    if vid is not None:
        rate_str = vid.get("avg_frame_rate") or vid.get("r_frame_rate") or "0/1"
        try:
            num, den = rate_str.split("/")
            fps = float(num) / float(den) if float(den) else 0.0
        except Exception:
            fps = 0.0
        info["video"] = {
            "index": vid.get("index"),
            "width": int(vid.get("width") or 0),
            "height": int(vid.get("height") or 0),
            "fps": round(fps, 6),
            "start_time": _f(vid.get("start_time"), 0.0),
            "codec": vid.get("codec_name"),
            "pix_fmt": vid.get("pix_fmt"),
        }
    if aud is not None:
        info["audio"] = {
            "index": aud.get("index"),
            "sample_rate": int(aud.get("sample_rate") or 48000),
            "channels": int(aud.get("channels") or 1),
            "start_time": _f(aud.get("start_time"), 0.0),
            "codec": aud.get("codec_name"),
        }
    return info


# ---------------------------------------------------------------------------
# 画面识别
# ---------------------------------------------------------------------------


def _parse_showinfo(stderr: str) -> list[tuple[int, float]]:
    """从 showinfo 输出中提取 (n, pts_time)."""
    import re

    out: list[tuple[int, float]] = []
    pat_n = re.compile(r"\bn:\s*(\d+)")
    pat_t = re.compile(r"\bpts_time:\s*([0-9.eE+-]+|NOPTS)")
    for line in stderr.splitlines():
        if "pts_time:" not in line or "n:" not in line:
            continue
        mn = pat_n.search(line)
        mt = pat_t.search(line)
        if not mn or not mt:
            continue
        try:
            out.append((int(mn.group(1)), float(mt.group(1))))
        except ValueError:
            continue
    return out


def _mean_luma_and_bright(rgb: np.ndarray) -> tuple[float, float]:
    arr = rgb.astype(np.float32)
    luma = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
    return float(luma.mean()), float((luma > 190.0).mean())


def _read_code_bits(rgb: np.ndarray) -> list[int]:
    """读取画面上方 10 段黑白编码."""
    h, w = rgb.shape[:2]
    y0 = int(h * 0.03) + 1
    y1 = max(y0 + 2, int(h * 0.13) - 1)
    margin = int(w * 0.04)
    usable = w - 2 * margin
    bw = usable / model.DETECT_CODE_BITS
    bits: list[int] = []
    for i in range(model.DETECT_CODE_BITS):
        cx = int(margin + (i + 0.5) * bw)
        x0, x1 = max(0, cx - 2), min(w, cx + 3)
        block = rgb[y0:y1, x0:x1].astype(np.float32)
        val = block.mean()
        bits.append(1 if val > 128.0 else 0)
    return bits


def _decode_runs(
    raw_path: str,
    frame_times: list[float],
    width: int,
    height: int,
    fps: float,
) -> tuple[np.ndarray, np.ndarray, list[list[int]]]:
    """返回每帧亮度, 是否为闪光, 以及闪光帧的编码位."""
    n = len(frame_times)
    mm = np.memmap(raw_path, dtype=np.uint8, mode="r", shape=(n, height, width, 3))
    luma = np.empty(n, dtype=np.float32)
    is_flash = np.zeros(n, dtype=bool)
    codes: list[list[int]] = []
    for i in range(n):
        frame = mm[i]
        mean, frac = _mean_luma_and_bright(frame)
        luma[i] = mean
        if mean >= FLASH_LUMA_MIN and frac >= FLASH_BRIGHT_FRACTION:
            is_flash[i] = True
            codes.append(_read_code_bits(frame))
        else:
            codes.append([])
    del mm
    return luma, is_flash, codes


def _vote_bits(codes: list[list[int]]) -> list[int] | None:
    if not codes:
        return None
    if len(codes) == 1:
        return codes[0]
    bits = []
    for k in range(model.DETECT_CODE_BITS):
        ones = sum(c[k] for c in codes)
        bits.append(1 if ones >= (len(codes) + 1) // 2 else 0)
    return bits


def _detect_video(film_path: str, probe: dict[str, Any],
                  tmpdir: str) -> tuple[list[VideoDetection], dict[str, Any]]:
    vin = probe.get("video")
    if not vin:
        return [], {"decoded_frames": 0}
    raw_path = os.path.join(tmpdir, "video.raw")
    cmd = [
        _which("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "info", "-y",
        "-i", film_path, "-map", "0:v:0",
        "-vf", f"scale={DECODE_W}:{DECODE_H},showinfo=checksum=0",
        "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-an", "-sn", raw_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                          check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"画面解码失败: {proc.stderr.decode('utf-8', 'replace')[-1200:]}")
    info = _parse_showinfo(proc.stderr.decode("utf-8", "replace"))
    if not info:
        raise RuntimeError("无法从 showinfo 输出解析出帧时间戳")
    frame_times_raw = [t for _, t in info]
    n = len(frame_times_raw)
    if os.path.getsize(raw_path) != n * DECODE_W * DECODE_H * 3:
        raise RuntimeError("解码帧数与原始数据大小不一致")

    fps = float(vin.get("fps") or 0.0)
    if not fps:
        # 用 PTS 中位数估算
        diffs = np.diff(np.array(frame_times_raw[:200]))
        fps = round(1.0 / float(np.median(diffs))) if len(diffs) else 0.0
    fmt_start = float(probe.get("start_time") or 0.0)
    origin = _origin_time(probe)
    # showinfo 的 pts_time 以 ffmpeg 的输入零点(通常= format.start_time)为 0;
    # 加回 fmt_start 得到容器绝对时刻, 再减去片子第一帧的时刻 = 与计划同一把尺子.
    times = [fmt_start + t - origin for t in frame_times_raw]

    luma, is_flash, codes = _decode_runs(raw_path, times, DECODE_W, DECODE_H, fps)

    # 连续闪光帧 -> run
    runs: list[dict[str, Any]] = []
    i = 0
    while i < n:
        if not is_flash[i]:
            i += 1
            continue
        j = i
        run_codes = []
        while j < n and is_flash[j]:
            if codes[j]:
                run_codes.append(codes[j])
            j += 1
        bits = _vote_bits(run_codes)
        mid = model.id_from_code_bits(bits) if bits else None
        raw_code = "".join(str(b) for b in bits) if bits else ""
        runs.append({"start": i, "end": j - 1, "id": mid, "raw": raw_code,
                     "codes": run_codes})
        i = j

    # 合并短暂重复帧: 同编号, 间隔很小, 且第二段很短
    merged: list[dict[str, Any]] = []
    for run in runs:
        if merged and run["id"] == merged[-1]["id"] and run["id"] is not None:
            gap = run["start"] - merged[-1]["end"] - 1
            length = run["end"] - run["start"] + 1
            if gap <= MERGE_GAP_FRAMES and length <= MERGE_MAX_DUP_FRAMES:
                merged[-1]["end"] = merged[-1]["end"]  # 主段结束时间不变
                merged[-1]["dup_frames"] += length
                merged[-1]["merged_runs"] += 1
                merged[-1]["dup_ranges"].append((run["start"], run["end"]))
                continue
        merged.append({**run, "dup_frames": 0, "merged_runs": 1, "dup_ranges": []})

    # 若同一段内位投票失败, 用该段每一帧再逐个解码
    detections: list[VideoDetection] = []
    for run in merged:
        mid = run["id"]
        if mid is None:
            for k in range(run["start"], run["end"] + 1):
                if codes[k]:
                    cand = model.id_from_code_bits(codes[k])
                    if cand is not None:
                        mid = cand
                        break
        detections.append(VideoDetection(
            id=mid,
            start_frame=run["start"],
            end_frame=run["end"],
            start_time=round(times[run["start"]], 6),
            end_time=round(times[run["end"]], 6),
            frame_count=run["end"] - run["start"] + 1,
            merged_runs=run["merged_runs"],
            raw_code=run["raw"],
            duplicate_frames=run["dup_frames"],
        ))

    stats = {
        "decoded_frames": n,
        "fps": fps,
        "flash_runs": len(runs),
        "detections": len(detections),
        "merge_gap_frames": MERGE_GAP_FRAMES,
        "luma_min": round(float(luma.min()), 2) if n else 0.0,
        "luma_max": round(float(luma.max()), 2) if n else 0.0,
        "decode_size": [DECODE_W, DECODE_H],
        "first_frame_time": round(times[0], 6) if times else None,
        "last_frame_time": round(times[-1], 6) if times else None,
        "frame_interval": round(float(np.median(np.diff(times[:200]))), 6)
        if n >= 2 else None,
        "frame_times": list(times),
        "raw_path": raw_path,
    }
    return detections, stats

# ---------------------------------------------------------------------------
# 声音识别
# ---------------------------------------------------------------------------


def _decode_audio(film_path: str, probe: dict[str, Any], tmpdir: str) -> tuple[np.ndarray, int, float]:
    a = probe.get("audio")
    if not a:
        return np.zeros(0, dtype=np.float32), 48000, 0.0
    sr = int(a.get("sample_rate") or 48000)
    out = os.path.join(tmpdir, "audio.f32")
    cmd = [
        _which("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", film_path, "-map", "0:a:0", "-vn", "-sn",
        "-ac", "1", "-ar", str(sr), "-f", "f32le", "-acodec", "pcm_f32le", out,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"声音解码失败: {proc.stderr.decode('utf-8', 'replace')[-1200:]}")
    samples = np.fromfile(out, dtype=np.float32)
    # 第 0 个解码采样对应的片子时刻 = 音频流起点 - 片子零点.
    # (ffmpeg 解码时会按 initial_padding 丢弃编码预热, 采样序号已是有效时间.)
    start = float(a.get("start_time") or 0.0) - _origin_time(probe)
    return samples, sr, start


def _moving_rms(x: np.ndarray, win: int) -> np.ndarray:
    if len(x) == 0:
        return x
    win = max(1, int(win))
    c = np.cumsum(np.square(x, dtype=np.float64), dtype=np.float64)
    c = np.concatenate(([0.0], c))
    rms = np.empty(len(x), dtype=np.float64)
    half = win // 2
    for i in range(0, len(x), 4096):
        j = min(len(x), i + 4096)
        lo = np.maximum(0, np.arange(i, j) - half)
        hi = np.minimum(len(x), np.arange(i, j) + half + 1)
        rms[i:j] = np.sqrt((c[hi] - c[lo]) / np.maximum(1, hi - lo))
    return rms.astype(np.float32)


def _goertzel_mags(x: np.ndarray, freqs: list[float], sr: int) -> np.ndarray:
    n = len(x)
    if n < 8:
        return np.zeros(len(freqs), dtype=np.float64)
    t = np.arange(n, dtype=np.float64)
    mags = np.empty(len(freqs), dtype=np.float64)
    for k, f in enumerate(freqs):
        w = 2.0 * np.pi * f / sr
        c = np.cos(w * t)
        s = np.sin(w * t)
        re = float(np.dot(x, c))
        im = float(np.dot(x, s))
        mags[k] = 2.0 * math.hypot(re, im) / n
    return mags


def _find_burst_samples(samples: np.ndarray, sr: int) -> list[tuple[int, int]]:
    if len(samples) < sr * 0.02:
        return []
    rms = _moving_rms(samples, int(sr * 0.0025))
    noise = float(np.median(rms))
    peak = float(np.quantile(rms, 0.999))
    thr = max(noise * 8.0, peak * 0.06, AUDIO_RMS_THRESHOLD_FLOOR)
    above = rms > thr
    regions: list[tuple[int, int]] = []
    i = 0
    n = len(above)
    while i < n:
        if not above[i]:
            i += 1
            continue
        j = i
        while j < n and above[j]:
            j += 1
        regions.append((i, j))
        i = j

    # 合并间隙很小的区域
    merged: list[tuple[int, int]] = []
    gap_samples = int(AUDIO_MERGE_GAP_S * sr)
    for a, b in regions:
        if merged and a - merged[-1][1] <= gap_samples:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))

    # 细化边界: 找到真正的波形起始
    refined: list[tuple[int, int]] = []
    amp_thr = max(0.02, float(np.quantile(np.abs(samples), 0.9995)) * 0.12)
    search = int(sr * 0.012)
    for a, b in merged:
        lo = max(0, a - search)
        hi = min(len(samples), b + search)
        seg = np.abs(samples[lo:hi])
        idx = np.nonzero(seg >= amp_thr)[0]
        if len(idx) == 0:
            continue
        s0 = lo + int(idx[0])
        # 结束位置: 从尾部往前找最后一个超过阈值处
        s1 = lo + int(idx[-1]) + 1
        if s1 - s0 >= int(sr * 0.015):
            refined.append((s0, s1))
    return refined


def _detect_audio(samples: np.ndarray, sr: int, audio_start: float) -> list[AudioDetection]:
    palette = list(model.TONE_PALETTE_HZ)
    bursts = _find_burst_samples(samples, sr)
    dets: list[AudioDetection] = []
    for a, b in bursts:
        length = b - a
        core_lo = a + int(length * 0.20)
        core_hi = b - int(length * 0.20)
        core = samples[core_lo:max(core_lo + 8, core_hi)].astype(np.float64)
        mags = _goertzel_mags(core, palette, sr)
        order = np.argsort(mags)[::-1]
        best = int(order[0])
        second = float(mags[order[1]]) if len(order) > 1 else 0.0
        best_mag = float(mags[best])
        total = float(mags.sum()) or 1e-9
        confidence = best_mag / total
        ratio = best_mag / second if second > 1e-9 else 99.0
        freq = float(palette[best])
        mid = model.id_for_tone(freq, TONE_FREQ_TOL_HZ) if ratio >= 1.35 else None
        peak = float(np.max(np.abs(samples[a:b]))) if length else 0.0
        dets.append(AudioDetection(
            id=mid,
            freq_hz=freq,
            start_sample=a,
            end_sample=b,
            start_time=round(audio_start + a / sr, 6),
            end_time=round(audio_start + b / sr, 6),
            peak=round(peak, 4),
            confidence=round(confidence, 3),
        ))
    return dets


# ---------------------------------------------------------------------------
# 分析入口
# ---------------------------------------------------------------------------


@dataclass
class Analysis:
    film_path: str
    probe: dict[str, Any]
    video_detections: list[VideoDetection]
    audio_detections: list[AudioDetection]
    stats: dict[str, Any] = field(default_factory=dict)
    tmpdir: str | None = None
    wav_path: str | None = None
    # 回读用的原始解码数据 (不写入 JSON, 只供 GUI 逐帧对照)
    video_times: list[float] = field(default_factory=list)
    video_raw_path: str | None = None
    video_decode_w: int = 0
    video_decode_h: int = 0
    audio_samples: Any = None
    audio_sample_rate: int = 48000
    audio_start: float = 0.0
    raw_audio_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        vstats = {k: v for k, v in (self.stats.get("video") or {}).items()
                  if k not in ("frame_times", "raw_path")}
        astats = {k: v for k, v in (self.stats.get("audio") or {}).items()
                  if k not in ("samples_data",)}
        return {
            "film": self.probe,
            "video_detections": [d.to_dict() for d in self.video_detections],
            "audio_detections": [d.to_dict() for d in self.audio_detections],
            "stats": {"video": vstats, "audio": astats},
        }

    # ---- 回读帮助方法 -------------------------------------------------------
    def video_frame_count(self) -> int:
        return len(self.video_times)

    def frame_time(self, index: int) -> float | None:
        if 0 <= index < len(self.video_times):
            return self.video_times[index]
        return None

    def frame_rgb(self, index: int) -> np.ndarray | None:
        """按解码后的分辨率读取一帧 (用于前后帧并排展示)."""
        if not self.video_raw_path or not (0 <= index < len(self.video_times)):
            return None
        w, h = self.video_decode_w, self.video_decode_h
        fsize = w * h * 3
        try:
            with open(self.video_raw_path, "rb") as fh:
                fh.seek(index * fsize)
                buf = fh.read(fsize)
            if len(buf) != fsize:
                return None
            return np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3).copy()
        except OSError:
            return None

    def audio_slice(self, t0: float, t1: float) -> np.ndarray:
        """取 [t0, t1] 秒的单声道样本 (相对于片子零点)."""
        if self.audio_samples is None:
            return np.zeros(0, dtype=np.float32)
        sr = self.audio_sample_rate
        a = int(round((t0 - self.audio_start) * sr))
        b = int(round((t1 - self.audio_start) * sr))
        a = max(0, min(len(self.audio_samples), a))
        b = max(0, min(len(self.audio_samples), b))
        return self.audio_samples[a:b]

    def sample_index_at(self, t: float) -> int:
        return int(round((t - self.audio_start) * self.audio_sample_rate))

    def time_at_sample(self, index: int) -> float:
        return self.audio_start + index / float(self.audio_sample_rate)

    def release(self) -> None:
        import shutil

        if self.tmpdir:
            shutil.rmtree(self.tmpdir, ignore_errors=True)
            self.tmpdir = None
        self.video_raw_path = None
        self.raw_audio_path = None
        self.audio_samples = None


def analyze_film(path: str) -> Analysis:
    """独立识别; 不读取任何计划文件."""
    probe = probe_film(path)
    tmpdir = tempfile.mkdtemp(prefix="syncmark-dec-")
    try:
        vdets, vstats = _detect_video(path, probe, tmpdir)
        samples, sr, astart = _decode_audio(path, probe, tmpdir)
        adets = _detect_audio(samples, sr, astart)
        stats = {
            "video": vstats,
            "audio": {
                "sample_rate": sr,
                "samples": int(len(samples)),
                "detections": len(adets),
                "rms_peak": round(float(np.max(np.abs(samples))) if len(samples) else 0.0, 4),
            },
        }
        return Analysis(
            path, probe, vdets, adets, stats, tmpdir, None,
            video_times=list(vstats.get("frame_times", [])),
            video_raw_path=vstats.get("raw_path"),
            video_decode_w=DECODE_W, video_decode_h=DECODE_H,
            audio_samples=samples, audio_sample_rate=sr, audio_start=astart,
            raw_audio_path=os.path.join(tmpdir, "audio.f32"),
        )
    except BaseException:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)
        raise


def write_audio_cache(analysis: Analysis) -> str:
    """把解码后的单声道音频写成 16-bit WAV, 供 GUI 试听."""
    if analysis.wav_path and os.path.isfile(analysis.wav_path):
        return analysis.wav_path
    out = os.path.join(analysis.tmpdir or tempfile.mkdtemp(prefix="syncmark-wav-"), "audio.wav")
    cmd = [
        _which("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", analysis.film_path, "-map", "0:a:0?", "-vn", "-sn",
        "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-y", out,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not os.path.isfile(out):
        return ""
    analysis.wav_path = out
    return out


# ---------------------------------------------------------------------------
# 匹配与同步判定
# ---------------------------------------------------------------------------


def _quantize_residual(t: float, fps: float) -> float:
    """画面时间对齐到帧格, 避免 1/fps 的取整误差被当成偏移."""
    if fps <= 0:
        return t
    return round(t * fps) / fps


def _offset_estimate(residuals: list[float], tolerance: float) -> dict[str, Any]:
    if not residuals:
        return {"seconds": 0.0, "applicable": False, "support": 0,
                "mad": None, "reason": "没有可用于估计的事件"}
    med = float(statistics.median(residuals))
    mad = float(statistics.median([abs(r - med) for r in residuals]))
    support = len(residuals)
    applicable = (
        support >= model.GLOBAL_MIN_SUPPORT
        and abs(med) >= model.GLOBAL_MIN_S
        and mad <= model.GLOBAL_MAD_MAX_S
    )
    reason = "ok" if applicable else (
        "样本不足" if support < model.GLOBAL_MIN_SUPPORT
        else "偏移不显著" if abs(med) < model.GLOBAL_MIN_S
        else "离散度偏大, 更可能是多个个别事件")
    return {
        "seconds": round(med, 6),
        "applicable": applicable,
        "support": support,
        "mad": round(mad, 6),
        "reason": reason,
    }


def _pair_indices(video_dets: list[VideoDetection],
                  audio_dets: list[AudioDetection]) -> tuple[dict[int, int], list[int]]:
    """把画面闪光和声音提示按时间就近配对, 只用于把"计划外"的检出归组.

    配对不跨编号 (已知编号时), 也不跨 0.45s.
    返回 {video_index: audio_index} 和未配对的音频索引.
    """
    pairs: dict[int, int] = {}
    used: set[int] = set()
    for vi, vd in enumerate(video_dets):
        best = None
        best_dt = 0.45
        for ai, ad in enumerate(audio_dets):
            if ai in used:
                continue
            if vd.id is not None and ad.id is not None and vd.id != ad.id:
                continue
            dt = abs(ad.start_time - vd.start_time)
            if dt <= best_dt:
                best_dt = dt
                best = ai
        if best is not None:
            pairs[vi] = best
            used.add(best)
    return pairs, [i for i in range(len(audio_dets)) if i not in used]


def _stats_for_json(stats: dict[str, Any]) -> dict[str, Any]:
    """去掉仅供回读使用的原始数据, 只保留可序列化的统计."""
    out = {}
    for ch, d in (stats or {}).items():
        if isinstance(d, dict):
            out[ch] = {k: v for k, v in d.items() if k not in ("frame_times", "raw_path")}
        else:
            out[ch] = d
    return out


def _boundary_checks(analysis: Analysis, report: dict[str, Any]) -> dict[str, Any]:
    """检查片子的首尾结构: 起点是否落在第一帧, 末尾是正常留白还是"刚好少一段".

    这里只如实报告结构, 不把"末尾缺一段"当作失败 —— 它本身就是一种需要被
    验证出来的状态.
    """
    probe = analysis.probe
    vstats = analysis.stats.get("video") or {}
    fps = float(vstats.get("fps") or 0.0) or 1.0
    events = report["events"]
    plan_events = [e for e in events if e["source"] == "plan"]
    first_plan = plan_events[0] if plan_events else None
    last_plan = plan_events[-1] if plan_events else None

    checks: list[dict[str, Any]] = []
    first_frame_t = vstats.get("first_frame_time")
    last_frame_t = vstats.get("last_frame_time")
    frames = int(vstats.get("decoded_frames") or 0)

    # ---- 起点 ----
    start_item: dict[str, Any] = {"name": "起点", "passed": False, "detail": ""}
    if first_frame_t is not None:
        start_item["first_frame_time"] = round(float(first_frame_t), 6)
        start_item["first_frame_index"] = 0
        if first_plan is not None:
            start_item["first_plan_time"] = first_plan["plan_time"]
            if first_plan["video"] is not None:
                start_item["first_detected_frame"] = first_plan["video"]["start_frame"]
                on_zero = abs(first_frame_t) <= 1.0 / fps * 1.5
                passed = first_plan["video"]["start_frame"] <= 1 or on_zero
                start_item["passed"] = bool(passed)
                start_item["mode"] = ("首标记就在第一帧" if first_plan["video"]["start_frame"] == 0
                                      else "首标记之前有前导画面")
                start_item["detail"] = (
                    f"第一帧 t={first_frame_t:.6f}s; 首个计划标记 t={first_plan['plan_time']:.6f}s, "
                    f"检出于第 {first_plan['video']['start_frame']} 帧")
            else:
                # 首个标记的画面缺失, 只能看片子本身是否从第一帧开始
                on_zero = abs(first_frame_t) <= 1.0 / fps * 1.5
                start_item["passed"] = bool(on_zero)
                start_item["mode"] = "首标记画面缺失"
                start_item["detail"] = f"第一帧 t={first_frame_t:.6f}s; 首个计划标记无画面检出"
        else:
            # 没有计划: 只检查片子本身是否从 0 开始, 并与第一个独立检出比较
            on_zero = abs(first_frame_t) <= 1.0 / fps * 1.5
            first_det = (report["detections"]["video"] or [None])[0]
            start_item["passed"] = bool(on_zero)
            start_item["mode"] = "无计划, 只看片子自身"
            if first_det:
                start_item["first_detected_frame"] = first_det["start_frame"]
                start_item["detail"] = (
                    f"第一帧 t={first_frame_t:.6f}s; 首个独立检出在第 "
                    f"{first_det['start_frame']} 帧 (t={first_det['start_time']:.6f}s)")
            else:
                start_item["detail"] = f"第一帧 t={first_frame_t:.6f}s; 未检出任何画面标记"
    checks.append(start_item)

    # ---- 末尾 ----
    tail_item: dict[str, Any] = {"name": "末尾", "passed": True, "detail": ""}
    last_detected_end = None
    video_ends = [e["video"]["end_time"] for e in plan_events if e["video"] is not None]
    if video_ends:
        last_detected_end = max(video_ends)
    else:
        audio_ends = [e["audio"]["end_time"] for e in plan_events if e["audio"] is not None]
        if audio_ends:
            last_detected_end = max(audio_ends)
    if last_frame_t is not None and last_detected_end is not None:
        tail_s = float(last_frame_t) - float(last_detected_end)
        tail_frames = int(round(tail_s * fps))
        abrupt = tail_s < 0.10
        tail_item.update({
            "last_frame_time": round(float(last_frame_t), 6),
            "last_detected_end_time": round(float(last_detected_end), 6),
            "tail_after_last_event_s": round(tail_s, 6),
            "tail_after_last_event_frames": tail_frames,
            "ends_abruptly": bool(abrupt),
            "mode": ("末尾缺段" if abrupt else "末尾留有普通画面"),
            "detail": (f"末帧 t={float(last_frame_t):.6f}s, 最后检出事件结束于 "
                       f"t={float(last_detected_end):.6f}s, 余量 {tail_frames} 帧"),
        })
    if last_plan is not None and last_plan["video"] is None and last_plan["audio"] is None:
        tail_item["missing_last_plan_marker"] = last_plan["id"]
        tail_item["passed"] = True  # 末尾缺段本身合法, 只是需要被指出
    checks.append(tail_item)

    # ---- 时间轴原点 ----
    if first_frame_t is not None:
        checks.append({
            "name": "时间轴原点",
            "passed": bool(abs(first_frame_t) <= 1.0 / fps * 1.5),
            "detail": f"第一帧 t={float(first_frame_t):.6f}s "
                      f"(媒体流 start_time={probe['video']['start_time']})",
        })

    missing_tail = bool(tail_item.get("missing_last_plan_marker"))
    return {
        "passed": all(c["passed"] for c in checks),
        "items": checks,
        "first_frame_time": None if first_frame_t is None else round(float(first_frame_t), 6),
        "decoded_frames": frames,
        "ends_with_missing_segment": missing_tail,
        "summary": ("起点紧贴第一帧" if checks and checks[0]["passed"] else "起点异常"),
    }


def _match_by_id(markers: list[dict[str, Any]], dets: list[Any],
                 limiter: float | None) -> tuple[dict[int, int], dict[int, int]]:
    """先把计划标记按编号配到最近的检出, 再用整体偏移筛掉明显不对的配对.

    返回 (marker_index -> detection_index, marker_index -> 残差).
    limiter 为 None 时先不做窗口限制(以便容忍较大的整体平移).
    """
    cand: dict[int, int] = {}
    res: dict[int, float] = {}
    used: set[int] = set()
    for mi, m in enumerate(markers):
        best = None
        best_dt = None
        for di, d in enumerate(dets):
            if di in used or d.id is None or d.id != m["id"]:
                continue
            dt = abs(d.start_time - m["time"])
            if best_dt is None or dt < best_dt:
                best_dt = dt
                best = di
        if best is not None:
            cand[mi] = best
            res[mi] = dets[best].start_time - m["time"]
            used.add(best)

    if limiter is None or not res:
        return cand, res

    # 用中位数作为整体偏移的粗估, 只保留与之相差不超过 limiter 的配对
    med = float(statistics.median(list(res.values())))
    keep: dict[int, int] = {}
    keep_res: dict[int, float] = {}
    for mi, di in cand.items():
        if abs(res[mi] - med) <= limiter:
            keep[mi] = di
            keep_res[mi] = res[mi]
    return keep, keep_res


def match_plan(analysis: Analysis, plan: dict[str, Any]) -> dict[str, Any]:
    """把独立检出的结果与计划对齐, 给出同步判定报告."""
    fps = float((analysis.probe.get("video") or {}).get("fps") or 0.0)
    markers = list(plan.get("markers", []))
    vdets = analysis.video_detections
    adets = analysis.audio_detections

    # 画面/声音各自按编号配对, 允许整体大平移; 再用中位数筛掉明显错配的
    v_for_marker, vres_by_marker = _match_by_id(markers, vdets, model.MATCH_WINDOW_S)
    a_for_marker, ares_by_marker = _match_by_id(markers, adets, model.MATCH_WINDOW_S)
    v_used = set(v_for_marker.values())
    a_used = set(a_for_marker.values())

    # 判定整体偏移: 只用配上的样本
    offs_v = _offset_estimate(
        [_quantize_residual(vres_by_marker[mi], fps) for mi in v_for_marker],
        model.EVENT_TOL_S)
    offs_a = _offset_estimate(
        [ares_by_marker[mi] for mi in a_for_marker], model.EVENT_TOL_S)

    gv = offs_v["seconds"] if offs_v["applicable"] else 0.0
    ga = offs_a["seconds"] if offs_a["applicable"] else 0.0

    events: list[dict[str, Any]] = []
    for mi, m in enumerate(markers):
        vi = v_for_marker.get(mi)
        ai = a_for_marker.get(mi)
        vd = vdets[vi] if vi is not None else None
        ad = adets[ai] if ai is not None else None
        vres = None
        ares = None
        v_adj = None
        a_adj = None
        if vd is not None:
            vres = _quantize_residual(vd.start_time - m["time"], fps)
            v_adj = vres - (gv if offs_v["applicable"] else 0.0)
        if ad is not None:
            ares = ad.start_time - m["time"]
            a_adj = ares - (ga if offs_a["applicable"] else 0.0)

        problems: list[str] = []
        if vd is None:
            problems.append("画面缺失")
        if ad is None:
            problems.append("声音缺失")
        tags: list[str] = []
        if v_adj is not None and abs(v_adj) > model.EVENT_TOL_S:
            tags.append("画面个别偏移")
        elif vres is not None and offs_v["applicable"]:
            tags.append("画面整体偏移")
        if a_adj is not None and abs(a_adj) > model.EVENT_TOL_S:
            tags.append("声音个别偏移")
        elif ares is not None and offs_a["applicable"]:
            tags.append("声音整体偏移")

        if vd is None and ad is None:
            status = "missing"
        elif vd is not None and ad is not None:
            status = "matched"
        elif vd is not None:
            status = "video_only"
        else:
            status = "audio_only"
        if status == "matched" and tags:
            status = "matched_with_issue" if any("个别" in t for t in tags) else status

        # 个别事件问题 = 该事件自身与计划不符 (缺失/半缺/扣除整体偏移后仍超差);
        # 仅仅因为整体偏移而被标记的, 不算个别问题.
        local_issue = bool(
            vd is None or ad is None
            or (v_adj is not None and abs(v_adj) > model.EVENT_TOL_S)
            or (a_adj is not None and abs(a_adj) > model.EVENT_TOL_S)
        )

        events.append({
            "key": f"plan:{m['id']}",
            "id": m["id"],
            "plan_frame": m.get("frame"),
            "plan_time": round(float(m["time"]), 6),
            "video": vd.to_dict() if vd else None,
            "audio": ad.to_dict() if ad else None,
            "video_index": vi,
            "audio_index": ai,
            "video_residual": None if vres is None else round(vres, 6),
            "audio_residual": None if ares is None else round(ares, 6),
            "video_adjusted": None if v_adj is None else round(v_adj, 6),
            "audio_adjusted": None if a_adj is None else round(a_adj, 6),
            "status": status,
            "problems": problems,
            "sync_tags": tags,
            "local_issue": local_issue,
            "source": "plan",
            "plan_marker": m,
        })

    # 多出来的检出 (计划里没有): 只有画面、只有声音、两者都有
    extra_v = [i for i in range(len(vdets)) if i not in v_used]
    extra_a = [i for i in range(len(adets)) if i not in a_used]

    # 把 extra 的画面和声音按时间就近配对 (同编号或未知编号)
    pairs, a_left = _pair_indices([vdets[i] for i in extra_v], [adets[i] for i in extra_a])
    grouped: dict[Any, dict[str, Any]] = {}
    for k, vi in enumerate(extra_v):
        ai = extra_a[pairs[k]] if k in pairs else None
        grouped[vi] = {"video": vdets[vi], "audio": adets[ai] if ai is not None else None,
                       "video_index": vi, "audio_index": ai}
    for ai in a_left:
        grouped[("a", extra_a[ai])] = {"video": None, "audio": adets[extra_a[ai]],
                                       "video_index": None, "audio_index": extra_a[ai]}

    for _group_key, g in grouped.items():
        vd = g["video"]
        ad = g["audio"]
        vi = g.get("video_index")
        ai = g.get("audio_index")
        if vd is not None and ad is not None:
            kind = "extra_pair"
        elif vd is not None:
            kind = "extra_video"
        else:
            kind = "extra_audio"
        events.append({
            "key": (f"extra:v{vd.start_frame}+a{ad.start_sample}" if kind == "extra_pair"
                    else f"extra:v{vd.start_frame}" if kind == "extra_video"
                    else f"extra:a{ad.start_sample}"),
            "id": vd.id if vd is not None else ad.id,
            "plan_frame": None,
            "plan_time": None,
            "video": vd.to_dict() if vd else None,
            "audio": ad.to_dict() if ad else None,
            "video_index": vi,
            "audio_index": ai,
            "video_residual": None,
            "audio_residual": None,
            "video_adjusted": None,
            "audio_adjusted": None,
            "status": "unplanned",
            "problems": ["计划外的额外标记"],
            "sync_tags": ["个别事件问题"],
            "local_issue": True,
            "source": "extra",
            "kind": kind,
        })

    matched_events = [e for e in events if e["source"] == "plan"]
    missing = [e for e in matched_events if e["status"] == "missing"]
    partial = [e for e in matched_events if e["status"] in ("video_only", "audio_only")]
    extra_events = [e for e in events if e["source"] == "extra"]

    report = {
        "schema": model.SCHEMA_REPORT,
        "created_utc": model.now_utc(),
        "film": analysis.probe,
        "plan_ref": plan.get("plan_path"),
        "plan": {
            "video": plan.get("video"),
            "audio": plan.get("audio"),
            "faults": plan.get("faults", {}),
            "marker_count": len(markers),
        },
        "detections": {
            "video": [d.to_dict() for d in vdets],
            "audio": [d.to_dict() for d in adets],
        },
        "stats": _stats_for_json(analysis.stats),
        "sync": {
            "video": offs_v,
            "audio": offs_a,
            "frames_per_sec": fps,
            "event_tolerance_s": model.EVENT_TOL_S,
            "match_window_s": model.MATCH_WINDOW_S,
        },
        "events": events,
        "groups": {
            "matched": [e for e in events if e.get("video") and e.get("audio")
                        and e["source"] == "plan" and e["status"] != "missing"],
            "unmatched_plan": missing + partial,
            "unmatched_detection": extra_events,
        },
        "summary": {
            "planned_markers": len(markers),
            "matched": len([e for e in matched_events if e["status"] in
                            ("matched", "matched_with_issue")]),
            "missing": len(missing),
            "partial": len(partial),
            "extra": len(extra_events),
            "video_detections": len(vdets),
            "audio_detections": len(adets),
            "global_video_offset_s": gv if offs_v["applicable"] else None,
            "global_audio_offset_s": ga if offs_a["applicable"] else None,
            "has_global_offset": bool(offs_v["applicable"] or offs_a["applicable"]),
            "has_local_issue": any(e.get("local_issue") for e in events),
        },
    }
    report["boundary"] = _boundary_checks(analysis, report)
    report["plan"]["markers"] = markers
    return report


def analyze_and_match(path: str, plan: dict[str, Any] | None) -> dict[str, Any]:
    analysis = analyze_film(path)
    if plan is None:
        plan = {"markers": [], "video": None, "audio": None, "faults": {},
                "plan_path": None}
    plan.setdefault("plan_path", None)
    report = match_plan(analysis, plan)
    report["analysis_tmpdir"] = analysis.tmpdir
    return report
