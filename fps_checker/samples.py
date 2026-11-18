"""程序自带样例生成: 带帧号、计时与同步短音的两份小样例。

- CFR 样例: 6.00s, 25fps 恒定帧率(150 帧)
- VFR 样例: 6.00s, 双速率交替 —— 每个循环 0.08s@50fps(4 个 0.02s 短帧)
  + 0.16s@25fps(4 个 0.04s 长帧), 共 25 循环 200 帧。长短间隔 2 倍差异,
  转 24/25/30fps 实测丢帧 56/50/41, 转 60fps 以重复帧为主。
  用多输入 concat filter + 显式 setpts 生成, 短帧时间戳不会被合并。

画面: 大帧号 + 零点计时 + 每秒前 80ms 的 BEEP 标记;
声音: 自写 WAV(标准库 wave), 每秒开头 80ms 的 880Hz 短音, 画面与声音同步。
"""
from __future__ import annotations

import math
import os
import struct
import wave

from PIL import Image, ImageDraw, ImageFont

from . import ffmpeg_utils

WIDTH, HEIGHT = 640, 360
SAMPLE_SECONDS = 6.0
BEEP_PERIOD = 1.0
BEEP_LEN = 0.08
BEEP_FREQ = 880
AUDIO_SR = 44100

# VFR 双速率段定义: (帧率, 段时长秒, 段内帧数)
# 50fps*4帧(0.08s) + 25fps*4帧(0.16s) = 每循环 0.24s, 25 循环整 6.00s
VFR_SEGMENTS = [(50, 0.08, 4), (25, 0.16, 4)]
VFR_CYCLES = 25

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _font(size: int):
    for p in _FONT_CANDIDATES:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def vfr_schedule() -> list[tuple[float, float]]:
    """返回 VFR 每帧的 (零点时间, 帧时长), 供生成与测试共用。"""
    out: list[tuple[float, float]] = []
    t = 0.0
    for _ in range(VFR_CYCLES):
        for rate, seg_dur, count in VFR_SEGMENTS:
            step = 1.0 / rate
            assert abs(step * count - seg_dur) < 1e-9
            for _ in range(count):
                out.append((t, step))
                t += step
    assert abs(t - SAMPLE_SECONDS) < 1e-9
    return out


def _beep_wav(path: str) -> None:
    """用标准库生成每秒一次 80ms 短音的单声道 WAV。"""
    n_total = int(SAMPLE_SECONDS * AUDIO_SR)
    n_beep = int(BEEP_LEN * AUDIO_SR)
    amp = 0.35 * 32767
    frames = []
    period_samples = int(BEEP_PERIOD * AUDIO_SR)
    for n in range(n_total):
        if (n % period_samples) < n_beep:
            val = int(amp * math.sin(2 * math.pi * BEEP_FREQ * n / AUDIO_SR))
        else:
            val = 0
        frames.append(struct.pack("<h", val))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(AUDIO_SR)
        w.writeframes(b"".join(frames))


def _render_frame(out_path, index, display_time, frame_dur, beep, title):
    # 背景随帧号渐变, 相邻帧差异肉眼可辨, 重复/丢弃一目了然
    r = (index * 7) % 256
    g = (index * 13 + 80) % 256
    b = (index * 29 + 160) % 256
    img = Image.new("RGB", (WIDTH, HEIGHT), (r, g, b))
    d = ImageDraw.Draw(img)
    big, mid, small = _font(110), _font(34), _font(24)

    d.text((20, 14), title, font=small, fill=(255, 255, 255))
    d.text((20, 52), f"frame {index:04d}", font=mid, fill=(255, 255, 255))
    d.text((WIDTH // 2, HEIGHT // 2 + 10), f"{index:04d}",
           font=big, fill=(255, 255, 255), anchor="mm")
    d.text((20, HEIGHT - 88),
           f"t = {display_time:7.3f} s", font=mid, fill=(255, 255, 255))
    if frame_dur is not None:
        d.text((20, HEIGHT - 46),
               f"frame duration = {frame_dur:.3f} s",
               font=small, fill=(255, 255, 255))
    if beep:
        d.ellipse((WIDTH - 84, 18, WIDTH - 24, 78), fill=(255, 60, 60))
        d.text((WIDTH - 54, 48), "BEEP", font=small,
               fill=(255, 255, 255), anchor="mm")
    img.save(out_path, quality=92)


def _frame_is_beep(t_start: float, t_end: float) -> bool:
    """帧显示区间与任一整点后的 80ms 短音窗口相交即标记。"""
    k = int(math.floor(t_start / BEEP_PERIOD))
    for sec in range(k, k + 2):
        b0 = sec * BEEP_PERIOD
        if t_start < b0 + BEEP_LEN and t_end > b0:
            return True
    return False


def generate_cfr(out_path: str, work_dir: str, fps: int = 25) -> str:
    """生成恒定帧率样例。"""
    img_dir = os.path.join(work_dir, "cfr_frames")
    os.makedirs(img_dir, exist_ok=True)
    count = int(round(SAMPLE_SECONDS * fps))
    dur = 1.0 / fps
    for i in range(count):
        t = i * dur
        _render_frame(
            os.path.join(img_dir, f"f_{i:05d}.jpg"),
            i, t, dur, _frame_is_beep(t, t + dur),
            f"CFR {fps}fps sample",
        )
    wav = os.path.join(work_dir, "beep.wav")
    _beep_wav(wav)
    ffmpeg_utils.run([
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(fps),
        "-i", os.path.join(img_dir, "f_%05d.jpg"),
        "-i", wav,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
        "-r", str(fps), "-fps_mode", "cfr",
        "-c:a", "aac", "-b:a", "128k",
        out_path,
    ])
    return out_path


def generate_vfr(out_path: str, work_dir: str) -> str:
    """生成明显长短帧间隔的 VFR 样例(concat filter + 显式 setpts)。"""
    img_dir = os.path.join(work_dir, "vfr_frames")
    os.makedirs(img_dir, exist_ok=True)
    schedule = vfr_schedule()

    # 每个速率段一个独立 image2 输入, 段内帧按该速率打时间戳,
    # 再用 concat filter 串联; setpts 以秒为单位(TB=1s)精确定位。
    seg_dirs: list[tuple[str, int, int]] = []  # (目录, 帧率, 帧数)
    frame_idx = 0
    seg_index = 0
    for _ in range(VFR_CYCLES):
        for rate, _seg_dur, count in VFR_SEGMENTS:
            sd = os.path.join(img_dir, f"seg_{seg_index:03d}")
            os.makedirs(sd, exist_ok=True)
            for j in range(count):
                t, step = schedule[frame_idx]
                _render_frame(
                    os.path.join(sd, f"f_{j:03d}.jpg"),
                    frame_idx, t, step,
                    _frame_is_beep(t, t + step),
                    "VFR sample 50fps/25fps alternating",
                )
                frame_idx += 1
            seg_dirs.append((sd, rate, count))
            seg_index += 1

    cmd = ["ffmpeg", "-y", "-v", "error"]
    for sd, rate, _ in seg_dirs:
        cmd += ["-f", "image2", "-framerate", str(rate),
                "-i", os.path.join(sd, "f_%03d.jpg")]
    wav = os.path.join(work_dir, "beep.wav")
    if not os.path.isfile(wav):
        _beep_wav(wav)
    audio_input_index = len(seg_dirs)
    cmd += ["-i", wav]

    filter_parts = []
    concat_labels = []
    for i, (_sd, rate, _c) in enumerate(seg_dirs):
        # 把该段时间戳转换为秒, 段内等间距 1/rate
        filter_parts.append(
            f"[{i}:v]settb=AVTB,setpts=N/{rate}/TB[s{i}]"
        )
        concat_labels.append(f"[s{i}]")
    filter_parts.append(
        f"{''.join(concat_labels)}concat=n={len(seg_dirs)}:v=1:a=0[vout]"
    )
    cmd += [
        "-filter_complex", ";".join(filter_parts),
        "-map", "[vout]", "-map", f"{audio_input_index}:a",
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
        "-fps_mode", "passthrough",
        "-video_track_timescale", "60000",
        "-c:a", "aac", "-b:a", "128k",
        out_path,
    ]
    ffmpeg_utils.run(cmd)
    return out_path


def generate_all(work_dir: str, out_dir: str) -> dict[str, str]:
    """在 out_dir 生成两份样例, 返回路径。"""
    os.makedirs(out_dir, exist_ok=True)
    cfr = os.path.join(out_dir, "sample_cfr_25fps.mp4")
    vfr = os.path.join(out_dir, "sample_vfr.mp4")
    generate_cfr(cfr, work_dir)
    generate_vfr(vfr, work_dir)
    return {"cfr": cfr, "vfr": vfr}
