"""测试短片的程序化生成: 画面 + 提示声 + 原计划.

* 画面: 每段普通画面的时长都不同 (0.8 s ~ 2.0 s), 闪光持续 3 帧并且顶部
  带 10 段黑白编码, 中央是大号编号.
* 声音: 每段闪光起点处一个 90 ms 的短音, 16 个编号对应 16 个相隔 120 Hz
  的音高, 因此仅靠声音也能区分编号.
* 不导入任何真实录音.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import wave
from typing import Any

import numpy as np

from . import model

# 7 段数码管的笔画定义(上, 右上, 右下, 下, 左下, 左上, 中)
_SEGMENTS = {
    0: (1, 1, 1, 1, 1, 1, 0),
    1: (0, 1, 1, 0, 0, 0, 0),
    2: (1, 1, 0, 1, 1, 0, 1),
    3: (1, 1, 1, 1, 0, 0, 1),
    4: (0, 1, 1, 0, 0, 1, 1),
    5: (1, 0, 1, 1, 1, 0, 1),
    6: (1, 0, 1, 1, 1, 1, 1),
    7: (1, 1, 1, 0, 0, 0, 0),
    8: (1, 1, 1, 1, 1, 1, 1),
    9: (1, 1, 1, 1, 0, 1, 1),
}


def _fill_rect(img: np.ndarray, x0: int, y0: int, x1: int, y1: int, color) -> None:
    h, w = img.shape[:2]
    xa, xb = max(0, int(x0)), min(w, int(x1))
    ya, yb = max(0, int(y0)), min(h, int(y1))
    if xa < xb and ya < yb:
        img[ya:yb, xa:xb] = color


def _draw_digit(img: np.ndarray, digit: int, x: int, y: int, w: int, h: int, color, t: int) -> None:
    seg = _SEGMENTS[digit % 10]
    th = max(2, t)
    gap = max(1, th // 2)
    on = lambda k: seg[k] == 1  # noqa: E731
    if on(0):
        _fill_rect(img, x + th, y, x + w - th, y + th, color)                  # 上
    if on(1):
        _fill_rect(img, x + w - th, y + th, x + w, y + h // 2, color)           # 右上
    if on(2):
        _fill_rect(img, x + w - th, y + h // 2 + gap, x + w, y + h - th, color) # 右下
    if on(3):
        _fill_rect(img, x + th, y + h - th, x + w - th, y + h, color)           # 下
    if on(4):
        _fill_rect(img, x, y + h // 2 + gap, x + th, y + h - th, color)         # 左下
    if on(5):
        _fill_rect(img, x, y + th, x + th, y + h // 2, color)                   # 左上
    if on(6):
        _fill_rect(img, x + th, y + h // 2 - gap // 2, x + w - th,
                   y + h // 2 + gap + (gap // 2) - 1, color)                    # 中


def _draw_number(img: np.ndarray, number: int, x: int, y: int, h: int, color) -> None:
    w = int(h * 0.55)
    t = max(2, int(h * 0.09))
    digits = f"{number:02d}" if number >= 10 else str(number)
    xx = x
    for ch in digits:
        _draw_digit(img, int(ch), xx, y, w, h, color, t)
        xx += w + int(h * 0.22)


def _base_frame(seg_index: int, frac: float, width: int, height: int,
                fps: int, total_hint: int) -> np.ndarray:
    """普通画面的底: 每段不同色相, 叠加缓慢移动的光带和段号."""
    hue = (seg_index * 0.37) % 1.0
    # 简化的 HSV -> RGB (固定 S=0.55, V=0.32), 每段一个不同色相
    i = int(hue * 6) % 6
    f = hue * 6 - int(hue * 6)
    r, g, b = [
        (0.32, 0.32 * (1 - f), 0.32 * (1 - f)),
        (0.32 * f, 0.32, 0.32 * (1 - f)),
        (0.32 * (1 - f), 0.32, 0.32 * f),
        (0.32 * (1 - f), 0.32 * (1 - f), 0.32),
        (0.32 * f, 0.32 * (1 - f), 0.32),
        (0.32, 0.32 * (1 - f), 0.32 * f),
    ][i]
    img = np.empty((height, width, 3), dtype=np.uint8)
    img[:] = (np.array([r, g, b], dtype=np.float32) * 255).astype(np.uint8)

    # 竖直移动光带, 保证每帧都不同
    xpos = int(width * ((frac + seg_index * 0.31) % 1.0))
    band_w = max(8, width // 20)
    strip = np.arange(-band_w, band_w, dtype=np.float32)
    glow = np.clip(1.0 - np.abs(strip) / band_w, 0, 1) * 0.35
    x0 = xpos - band_w
    for k in range(-band_w, band_w):
        xx = x0 + (k + band_w)
        if 0 <= xx < width:
            img[:, xx] = np.clip(img[:, xx].astype(np.float32) + glow[k + band_w] * 180.0, 0, 255).astype(np.uint8)

    # 角落的段号
    _draw_number(img, seg_index + 1, width - int(width * 0.14), int(height * 0.86),
                 int(height * 0.11), (200, 205, 210))
    return img


def _flash_frame(marker_id: int, width: int, height: int) -> np.ndarray:
    img = np.empty((height, width, 3), dtype=np.uint8)
    # 亮色底, 明显区别于暗背景
    img[:] = (250, 238, 120)

    # 顶部 10 段黑白编码
    bits = model.code_bits_for_id(marker_id)
    margin = int(width * 0.04)
    usable = width - 2 * margin
    bw = usable // len(bits)
    strip_y0 = int(height * 0.03)
    strip_h = int(height * 0.10)
    for i, bit in enumerate(bits):
        x0 = margin + i * bw
        color = (255, 255, 255) if bit else (12, 12, 12)
        _fill_rect(img, x0, strip_y0, x0 + bw, strip_y0 + strip_h, color)

    # 中央大号编号 (深色, 在亮底上)
    _draw_number(img, marker_id, int(width * 0.40), int(height * 0.30),
                 int(height * 0.44), (30, 20, 40))
    # 编号两侧的识别用色块
    _fill_rect(img, 0, height - int(height * 0.12), width // 4, height, (20, 40, 200))
    _fill_rect(img, width - width // 4, height - int(height * 0.12), width, height, (200, 30, 40))
    return img


def _tone_buffer(sample_rate: int, freq: float, ms: float) -> np.ndarray:
    n = int(sample_rate * ms / 1000.0)
    t = np.arange(n, dtype=np.float32) / sample_rate
    env = np.ones(n, dtype=np.float32)
    fade = max(1, int(sample_rate * 0.005))
    ramp = np.linspace(0.0, 1.0, fade, endpoint=False, dtype=np.float32)
    env[:fade] = ramp
    env[-fade:] = ramp[::-1]
    return (np.sin(2.0 * np.pi * freq * t).astype(np.float32)) * env * 0.55


def _build_audio(
    events: list[tuple[int, float]],
    *,
    total_samples: int,
    sample_rate: int,
    offset_s: float,
) -> np.ndarray:
    """events: (起始采样, 频率). 正 offset 表示声音整体偏晚."""
    buf = np.zeros(total_samples, dtype=np.float32)
    # 轻微底噪, 让声音更接近真实录音的寂静段
    rng = np.random.default_rng(20261126)
    buf += rng.normal(0, 0.0015, total_samples).astype(np.float32)

    shift = int(round(offset_s * sample_rate))
    for start, freq in events:
        src = _tone_buffer(sample_rate, freq, model.TONE_MS)
        pos = start + shift
        for k in range(len(src)):
            p = pos + k
            if 0 <= p < total_samples:
                buf[p] += src[k]
    return np.clip(buf, -1.0, 1.0)


def _write_wav(path: str, samples: np.ndarray, sample_rate: int) -> None:
    pcm = np.round(samples * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("找不到 ffmpeg, 请先安装并确保在 PATH 中")
    return exe


def _run(cmd: list[str], *, stdin_data=None) -> None:  # noqa: ANN001
    proc = subprocess.run(cmd, stdin=stdin_data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-1500:]
        raise RuntimeError(f"ffmpeg 失败 ({proc.returncode}):\n{tail}")


def generate_film(
    out_path: str,
    *,
    marker_count: int = model.DEFAULT_MARKER_COUNT,
    fps: int = model.DEFAULT_FPS,
    width: int = model.DEFAULT_WIDTH,
    height: int = model.DEFAULT_HEIGHT,
    sample_rate: int = model.DEFAULT_SAMPLE_RATE,
    first_at_zero: bool = False,
    audio_offset_ms: float = 0.0,
    missing_first: bool = False,
    repeat_mid: dict[str, int] | None = None,
    truncate_last: bool = False,
    duplicate_glitch: bool = False,
    event_shift: dict[str, Any] | None = None,
    write_plan_path: str | None = None,
) -> dict[str, Any]:
    """生成一段测试短片, 旁边写出原计划 JSON, 返回计划 dict.

    故障开关只会改变实际片子的内容, 计划时刻始终是"原计划":
    * audio_offset_ms: 整条音轨平移(正=偏晚).
    * missing_first: 首段(1 号)画面和声音都不出现.
    * repeat_mid: {"marker_id": n, "after_ms": m} 在第 n 段之后 m 毫秒重复
      同一编号的一次闪光+提示声 (m 默认 350ms).
    * truncate_last: 最后一段完全不出现, 片子停在倒数第二段结尾.
    * duplicate_glitch: 在某段闪光后插入一帧内容重复帧 (短暂的重复帧).
    * event_shift: {"marker_id": n, "video_ms": a, "audio_ms": b} 只把第 n 号的
      画面和/或声音单独平移, 用于制造"个别事件问题".
    """
    if marker_count < 1:
        raise ValueError("marker_count 至少为 1")
    plan = model.make_plan(
        marker_count=marker_count, fps=fps, width=width, height=height,
        sample_rate=sample_rate, first_at_zero=first_at_zero,
    )
    markers: list[dict[str, Any]] = plan["markers"]

    faults: dict[str, Any] = {}
    if audio_offset_ms:
        faults["global_audio_offset_ms"] = float(audio_offset_ms)
    if missing_first:
        faults["missing_first"] = True
    if repeat_mid:
        faults["repeat_mid"] = dict(repeat_mid)
    if truncate_last:
        faults["truncate_last"] = True
    if duplicate_glitch:
        faults["duplicate_glitch"] = True
    if event_shift:
        faults["event_shift"] = dict(event_shift)
    plan["faults"] = faults

    # ---- 决定实际要出现的标记 ----
    present = [m for m in markers if not (missing_first and m["id"] == 1)]
    if truncate_last and present:
        present = present[:-1]

    shift_spec = event_shift or {}
    shift_id = int(shift_spec.get("marker_id", 0)) if shift_spec else 0
    shift_video_frames = int(round(float(shift_spec.get("video_ms", 0)) * fps / 1000.0))
    shift_audio_ms = float(shift_spec.get("audio_ms", 0))

    actual_events: list[dict[str, Any]] = []   # 真实出现的事件
    for m in present:
        video_frame = m["frame"]
        audio_shift = 0.0
        if shift_id and m["id"] == shift_id:
            video_frame += shift_video_frames
            audio_shift = shift_audio_ms
        actual_events.append({
            "id": m["id"],
            "frame": video_frame,          # 画面实际帧号
            "plan_frame": m["frame"],      # 原计划帧号 (声音以它为基准)
            "kind": "primary",
            "audio_shift_ms": audio_shift,
        })

    repeat_spec = repeat_mid or None
    if repeat_spec:
        rid = int(repeat_spec.get("marker_id", present[len(present) // 2]["id"] if present else 1))
        after_frames = max(1, int(round(float(repeat_spec.get("after_ms", 350)) * fps / 1000.0)))
        base = next((m for m in present if m["id"] == rid), None)
        if base is not None:
            repeat_frame = base["frame"] + after_frames
            actual_events.append({"id": rid, "frame": repeat_frame,
                                  "plan_frame": repeat_frame, "kind": "repeat",
                                  "audio_shift_ms": 0.0})

    # 实际片子总帧数: 正常是计划总帧数; 末尾缺段则停在最后一个实际闪光结束
    total_frames = plan["video"]["frames"]
    if truncate_last and present:
        last = present[-1]
        total_frames = last["frame"] + model.FLASH_FRAMES + 2
    if repeat_spec and actual_events:
        extra = max(e["frame"] for e in actual_events) + model.FLASH_FRAMES + 2
        total_frames = max(total_frames, extra)

    # ---- 画面逐帧生成 ----
    flash_map: dict[int, int] = {}
    for e in actual_events:
        for k in range(model.FLASH_FRAMES):
            flash_map[e["frame"] + k] = e["id"]
    # 每一帧属于哪个计划段的索引 (按计划标记顺序)
    seg_starts = sorted({m["frame"]: i for i, m in enumerate(markers)}.items())
    seg_index_for = np.zeros(total_frames, dtype=np.int32)
    idx = 0
    for f in range(total_frames):
        # 位移过的标记单独占一段: 段号取它实际所在的计划槽
        while idx + 1 < len(seg_starts) and seg_starts[idx + 1][0] <= f:
            idx += 1
        seg_index_for[f] = seg_starts[idx][1]

    # 局部重复帧 (短暂重复帧): 在某个闪光结束后的第 2 帧位置, 把这一帧替换成
    # 该闪光的最后一帧内容 —— 等价于采集卡卡顿丢了一帧再重复上一帧.
    # 总帧数不变, 后面的时间轴不受影响; 识别时应把这次重复并入同一标记.
    glitch_frame = None
    if duplicate_glitch and actual_events:
        victim = actual_events[min(2, len(actual_events) - 1)]
        cand = victim["frame"] + model.FLASH_FRAMES + 1
        if cand < total_frames and cand > victim["frame"]:
            glitch_frame = cand

    # 先写到临时 raw 文件再让 ffmpeg 编码, 避免管道阻塞的死锁
    with tempfile.TemporaryDirectory(prefix="syncmark-gen-") as tmpdir:
        raw_path = os.path.join(tmpdir, "video.rgb")
        with open(raw_path, "wb") as fh:
            for f in range(total_frames):
                if f in flash_map:
                    img = _flash_frame(flash_map[f], width, height)
                elif glitch_frame is not None and f == glitch_frame:
                    # 重复上一帧(= 该闪光最后一帧)的内容
                    src = glitch_frame - 2
                    if src in flash_map:
                        img = _flash_frame(flash_map[src], width, height)
                    else:
                        img = _base_frame(int(seg_index_for[f]), f / max(total_frames, 1),
                                          width, height, fps, total_frames)
                else:
                    frac = f / max(total_frames, 1)
                    img = _base_frame(int(seg_index_for[f]), frac, width, height, fps, total_frames)
                fh.write(img.tobytes())

        audio_events = [(int(round((e["plan_frame"] * sample_rate / fps) +
                                   e.get("audio_shift_ms", 0.0) * sample_rate / 1000.0)),
                        model.tone_for_id(e["id"]))
                        for e in actual_events]
        total_samples = int(round(total_frames * sample_rate / fps))
        offset_s = audio_offset_ms / 1000.0
        audio = _build_audio(audio_events, total_samples=total_samples,
                             sample_rate=sample_rate, offset_s=offset_s)
        wav_path = os.path.join(tmpdir, "audio.wav")
        _write_wav(wav_path, audio, sample_rate)

        video_only = os.path.join(tmpdir, "video.mp4")
        _run([
            _ffmpeg(), "-hide_banner", "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
            "-r", str(fps), "-i", raw_path,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-bf", "0", "-g", str(fps),
            video_only,
        ])

        ext = os.path.splitext(out_path)[1].lower()
        if ext in ("", ".mov"):
            audio_codec = ["-c:a", "pcm_s16le"]
        else:
            audio_codec = ["-c:a", "aac", "-b:a", "192k"]
        _run([
            _ffmpeg(), "-hide_banner", "-y", "-loglevel", "error",
            "-i", video_only, "-i", wav_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", *audio_codec,
            "-movflags", "+faststart",
            out_path,
        ])

    plan["video"]["frames"] = total_frames
    plan["video"]["duration"] = round(total_frames / fps, 6)
    plan["video"]["glitch_duplicate_frames"] = 1 if duplicate_glitch else 0
    plan["actual_events"] = [
        {"id": e["id"], "frame": e["frame"], "time": round(e["frame"] / fps, 6),
         "plan_frame": e.get("plan_frame"), "kind": e["kind"],
         "audio_shift_ms": e.get("audio_shift_ms", 0.0)}
        for e in actual_events
    ]

    ppath = write_plan_path or model.plan_default_path(out_path)
    model.write_json_atomic(ppath, plan)
    return plan


PROFILES: dict[str, dict[str, Any]] = {
    "clean": {"title": "干净基线", "desc": "画面与声音都在计划时刻"},
    "offset": {"title": "整体音频偏移 +120ms", "desc": "整条音轨晚 120 ms", "audio_offset_ms": 120.0},
    "offset_early": {"title": "整体音频偏移 -90ms", "desc": "整条音轨早 90 ms", "audio_offset_ms": -90.0},
    "missing_first": {"title": "首段缺失 + 整体偏移",
                      "desc": "1 号标记画面和声音都消失, 音轨另晚 120 ms",
                      "missing_first": True, "audio_offset_ms": 120.0},
    "repeat_mid": {"title": "中部重复一次",
                   "desc": "6 号标记之后 350 ms 再重复一次闪光+提示声",
                   "repeat_mid": {"marker_id": 6, "after_ms": 350}},
    "event_shift": {"title": "个别事件偏移",
                    "desc": "7 号标记画面晚 4 帧、声音晚 60 ms, 其余正常",
                    "event_shift": {"marker_id": 7, "video_ms": 133.0, "audio_ms": 60.0}},
    "glitch": {"title": "短暂重复帧",
               "desc": "某段闪光后重复一帧, 不应算成第二次闪光",
               "duplicate_glitch": True},
    "full": {"title": "综合故障",
             "desc": "整体偏移 + 首段缺失 + 中部重复 + 重复帧 + 末尾缺段",
             "audio_offset_ms": 120.0, "missing_first": True,
             "repeat_mid": {"marker_id": 6, "after_ms": 350},
             "duplicate_glitch": True, "truncate_last": True},
    "edge_zero": {"title": "边界: 首标记在第 0 帧",
                  "desc": "整片第一帧就是 1 号标记", "first_at_zero": True},
    "edge_truncated": {"title": "边界: 末尾刚好少一段",
                       "desc": "最后一段不出现, 片子停在倒数第二段之后", "truncate_last": True},
}


def make_fault_profile(out_path: str, profile: str, **kwargs) -> dict[str, Any]:
    """按预设档位生成测试片."""
    if profile not in PROFILES:
        raise ValueError(f"未知档位: {profile}; 可用:{', '.join(PROFILES)}")
    opts = {k: v for k, v in PROFILES[profile].items() if k not in ("title", "desc")}
    opts.update(kwargs)
    return generate_film(out_path, **opts)
