"""程序化生成测试样例（全部由 ffmpeg lavfi 虚拟源合成，不依赖外部素材）。

每个样例是一个纯色画面 + 不同频率正弦音，颜色与频率一一对应，
导出后可直接按颜色核对片段顺序、按音量核对静音处理是否正确。
"""
from __future__ import annotations

import os

from .runner import run_ffmpeg

# (文件名, 宽, 高, 帧率, 时长秒, 颜色, 正弦频率Hz, 是否带声音)
# 颜色刻意取互相差异大、且在 yuv420p 有限色彩范围转换后仍可稳定区分的色值
SAMPLE_SPECS: list[tuple[str, int, int, str, float, str, int, bool]] = [
    ("clip1_1280x720_30.mp4",       1280, 720,  "30",        2.0, "red",    220, True),
    ("clip2_854x480_24.mp4",         854, 480,  "24",        2.0, "green",  330, True),
    ("clip3_720x1280_25.mp4",        720, 1280, "25",        2.0, "blue",   440, True),
    ("clip4_640x360_2997.mp4",       640, 360,  "30000/1001", 2.0, "yellow", 550, True),
    ("clip5_1920x1080_15.mp4",      1920, 1080, "15",        2.0, "purple", 660, True),
    ("clip6_1280x720_30_silent.mp4", 1280, 720, "30",        2.0, "cyan",     0, False),
]


def generate_samples(out_dir: str, progress_cb=None) -> list[str]:
    """在 out_dir 生成 6 个覆盖不同尺寸/帧率/静音情况的样例，返回路径列表。"""
    os.makedirs(out_dir, exist_ok=True)
    paths: list[str] = []
    total = len(SAMPLE_SPECS)
    for index, (name, w, h, fps, dur, color, tone, with_audio) in enumerate(SAMPLE_SPECS, 1):
        out_path = os.path.join(out_dir, name)
        video_src = f"color=c={color}:s={w}x{h}:r={fps}:d={dur}"
        if with_audio:
            args = [
                "-f", "lavfi", "-i", video_src,
                "-f", "lavfi", "-i", f"sine=frequency={tone}:sample_rate=48000:duration={dur}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                "-t", f"{dur:.3f}",
                "-shortest",
                out_path,
            ]
        else:
            args = [
                "-f", "lavfi", "-i", video_src,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-an",
                "-t", f"{dur:.3f}",
                out_path,
            ]
        status = f"生成样例 {index}/{total}：{name}"
        if progress_cb:
            progress_cb((index - 1) / total, status)
        run_ffmpeg(args, total_duration=dur, progress_cb=progress_cb,
                   status_text=status)
        paths.append(out_path)
    if progress_cb:
        progress_cb(1.0, f"已生成 {total} 个样例")
    return paths


def extract_thumbnail(video_path: str, out_path: str, at_seconds: float = 0.5) -> str:
    """抽一帧 PNG 供 UI 展示。"""
    args = [
        "-ss", f"{at_seconds:.3f}", "-i", video_path,
        "-frames:v", "1", "-an", out_path,
    ]
    run_ffmpeg(args)
    return out_path
