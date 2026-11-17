#!/usr/bin/env python3
"""loop_core.py — 循环区间/接缝算法的 Python 参考实现。

与 js/loop-core.js 逐行对应，tests/ 中的交叉校验会同时调用两边，
确保浏览器实际使用的算法与独立核对脚本完全一致。
"""


class LoopError(Exception):
    pass


def validate_loop(total_frames, start_frame, end_frame, fade_frames):
    if not isinstance(total_frames, int) or total_frames <= 0:
        raise LoopError("文件没有可用的音频帧")
    if not isinstance(start_frame, int) or not isinstance(end_frame, int):
        raise LoopError("起止位置必须是整数采样帧")
    if start_frame < 0 or end_frame > total_frames:
        raise LoopError("区间超出文件范围")
    if end_frame - start_frame < 2:
        raise LoopError("循环区间至少包含 2 个采样帧")
    length = end_frame - start_frame
    fade = max(0, int(fade_frames))
    max_fade = length // 2
    clamped = False
    if fade > max_fade:
        fade = max_fade
        clamped = True
    return {
        "start_frame": start_frame,
        "end_frame": end_frame,
        "length_frames": length,
        "fade_frames": fade,
        "max_fade_frames": max_fade,
        "fade_clamped": clamped,
    }


def raw_seam_jump(channels, start_frame, end_frame):
    return [abs(ch[end_frame - 1] - ch[start_frame]) for ch in channels]


def loop_seam_jump(loop_channels):
    n = len(loop_channels[0])
    return [abs(ch[n - 1] - ch[0]) for ch in loop_channels]


def build_loop(channels, start_frame, end_frame, fade_frames):
    """环形接缝交叉淡化，输出长度 = L - F，与 JS 端公式相同。"""
    cfg = validate_loop(len(channels[0]), start_frame, end_frame, fade_frames)
    length = cfg["length_frames"]
    fade = cfg["fade_frames"]
    out_len = length - fade
    tail = start_frame + length - fade
    out = [[0.0] * out_len for _ in channels]
    for n in range(out_len):
        if n < fade:
            g_head = (n + 1) / (fade + 1)
            g_tail = 1.0 - g_head
            for c, ch in enumerate(channels):
                out[c][n] = ch[tail + n] * g_tail + ch[start_frame + n] * g_head
        else:
            for c, ch in enumerate(channels):
                out[c][n] = ch[start_frame + n]
    return {"channels": out, "length_frames": out_len, "config": cfg}


def ms_to_frames(ms, sample_rate):
    if ms < 0:
        return 0
    return max(0, round(ms / 1000.0 * sample_rate))


def frames_to_ms(frames, sample_rate):
    return frames / sample_rate * 1000.0
