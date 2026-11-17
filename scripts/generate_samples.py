#!/usr/bin/env python3
"""生成测试用样例视频，无需用户自行准备素材。

只依赖 ffmpeg 的基础滤镜（color / testsrc / drawbox / xfade / transpose /
setpts / concat），不依赖 drawtext，未编译 libfreetype 的 ffmpeg 也能运行。

覆盖场景：
  sample_cut.mp4       明显的硬切换（四段颜色不同、带不同位置色块的画面）
  sample_gradual.mp4   渐变（xfade 淡入淡出过渡，无硬切）
  sample_vfr.mp4       可变帧率（真实帧间隔不均匀，用 ffprobe 可验证）
  sample_rotated.mp4   带 90° 旋转元数据的视频（编码画面为横向，显示应为竖向）
  sample_audio_only.m4a 无视频流（用于错误反馈测试）
  sample_corrupt.mp4   损坏文件（截断的 mp4，用于错误反馈测试）

用法：python scripts/generate_samples.py [输出目录]
"""

from __future__ import annotations

import os
import subprocess
import sys


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(
            f"命令失败 ({proc.returncode}):\n{' '.join(cmd)}\n{proc.stderr[-1500:]}"
        )


def passthrough_args() -> list[str]:
    """ffmpeg 5+ 用 -fps_mode，旧版本用 -vsync。"""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-h", "long"],
        capture_output=True, text=True, timeout=30,
    )
    if "-fps_mode" in proc.stdout + proc.stderr:
        return ["-fps_mode", "passthrough"]
    return ["-vsync", "passthrough"]


def gen_cut(out: str) -> None:
    """四段纯色 + 不同位置色块拼接，段间是硬切换。

    testsrc 自带滚动时间戳，录制后可逐帧核对真实取帧时间。
    """
    inputs: list[str] = []
    colors = ["red", "green", "blue", "yellow"]
    box_positions = ["20:20", "420:20", "20:200", "420:200"]
    filters: list[str] = []
    for i, (color, pos) in enumerate(zip(colors, box_positions)):
        inputs += [
            "-f", "lavfi",
            "-i", f"color=c={color}:s=640x360:d=2:r=25",
        ]
        filters.append(
            f"[{i}:v]drawbox=x={pos.split(':')[0]}:y={pos.split(':')[1]}:"
            f"w=200:h=120:color=white@0.85:t=fill[v{i}]"
        )
    filter_complex = ";".join(filters) + ";"
    filter_complex += "".join(f"[v{i}]" for i in range(4))
    filter_complex += "concat=n=4:v=1[v]"
    run(
        [
            "ffmpeg", "-y", *inputs,
            "-filter_complex", filter_complex,
            "-map", "[v]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            out,
        ]
    )


def gen_gradual(out: str) -> None:
    """两个片段之间用 xfade 做 1 秒淡入淡出，属于渐变而非硬切。"""
    filter_complex = "[0:v][1:v]xfade=transition=fade:duration=1:offset=2[v]"
    run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=navy:s=640x360:d=3:r=25",
            "-f", "lavfi", "-i", "color=c=orange:s=640x360:d=3:r=25",
            "-filter_complex", filter_complex,
            "-map", "[v]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            out,
        ]
    )


def gen_vfr(out: str) -> None:
    """生成真实帧间隔不均匀的 VFR 视频。

    三段帧率不同的 testsrc（25fps / 5fps / 25fps）经 concat 拼接并以
    passthrough 时间戳封装：拼接处帧间隔从 0.04s 跳变为 0.2s，ffprobe 可见
    pts_time 不均匀，且 avg_frame_rate 与 r_frame_rate 不一致。
    画面自带滚动时间戳，可逐帧核对取帧时间。
    """
    run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=s=640x360:d=2:r=25",
            "-f", "lavfi", "-i", "testsrc=s=640x360:d=2:r=5",
            "-f", "lavfi", "-i", "testsrc=s=640x360:d=2:r=25",
            "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]",
            "-map", "[v]",
            *passthrough_args(),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            out,
        ]
    )


def gen_rotated(out: str) -> None:
    """编码画面为横向 640x360，写入顺时针 90° 的 Display Matrix 元数据。

    -display_rotation 的角度为逆时针，故顺时针 90° 传 -90；
    -noautorotate 阻止 ffmpeg 在输入阶段物理旋转，保证编码画面保持横向、
    旋转仅存在于元数据中。播放器与本工具导出的截图都应显示为竖向 360x640。
    """
    run(
        [
            "ffmpeg", "-y",
            "-noautorotate", "-display_rotation", "-90",
            "-f", "lavfi", "-i", "testsrc=s=640x360:d=4:r=25",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            out,
        ]
    )


def gen_audio_only(out: str) -> None:
    run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:a", "aac",
            out,
        ]
    )


def gen_corrupt(good_video: str, out: str) -> None:
    """截断正常 mp4 的尾部，模拟损坏/未下载完成的文件。"""
    with open(good_video, "rb") as src, open(out, "wb") as dst:
        data = src.read()
        dst.write(data[: max(1, len(data) // 3)])


def main() -> None:
    out_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "samples")
    os.makedirs(out_dir, exist_ok=True)

    cut = os.path.join(out_dir, "sample_cut.mp4")
    gradual = os.path.join(out_dir, "sample_gradual.mp4")
    vfr = os.path.join(out_dir, "sample_vfr.mp4")
    rotated = os.path.join(out_dir, "sample_rotated.mp4")
    audio = os.path.join(out_dir, "sample_audio_only.m4a")
    corrupt = os.path.join(out_dir, "sample_corrupt.mp4")

    gen_cut(cut)
    gen_gradual(gradual)
    gen_vfr(vfr)
    gen_rotated(rotated)
    gen_audio_only(audio)
    gen_corrupt(cut, corrupt)

    print("\n样例已生成：")
    for name in (cut, gradual, vfr, rotated, audio, corrupt):
        print(" -", name)
    print(
        "\n验证 VFR：ffprobe -select_streams v:0 -show_entries frame=pts_time "
        f"-of csv=p=0 {vfr} | head -8"
    )
    print(
        "验证旋转：ffprobe -select_streams v:0 -show_streams "
        f"-of json {rotated} | grep -A3 side_data"
    )


if __name__ == "__main__":
    main()
