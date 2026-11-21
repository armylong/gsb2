"""ffmpeg 进程执行与预览代理片生成。"""
from __future__ import annotations

import os
import subprocess
import tempfile
from typing import List, Optional, Tuple

from .geometry import VideoGeometry
from .probe import find_ffmpeg


def run_ffmpeg(
    cmd: List[str],
    runner=None,
) -> Tuple[int, str]:
    """执行 ffmpeg 命令。

    允许注入 runner（测试用）；runner 收到完整参数列表，返回 returncode。
    """
    if runner is not None:
        return runner(cmd), ""
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return proc.returncode, proc.stderr


def make_preview_proxy(
    src_path: str,
    geom: VideoGeometry,
    mode: str,
    max_side: int = 480,
    tmp_dir: Optional[str] = None,
) -> str:
    """生成预览用的小代理片，返回临时文件路径。

    mode:
      "coded"   —— 按原始像素直接铺开（保留 PAR 形变、不应用方向），
                   用来直观看到“文件里到底存了什么”；
      "display" —— 按播放器方式显示（PAR 与方向全部烘焙、SAR=1、无方向元数据），
                   用来看到“播放器实际给用户看的画面”，也是点击取坐标的基准。
    """
    fd, out_path = tempfile.mkstemp(suffix=".mp4", prefix="vidgeo_", dir=tmp_dir)
    os.close(fd)

    if mode == "coded":
        # 不 autorotate、清方向元数据，并强制 SAR=1:
        # 这样播放器不会再按 PAR 拉伸，看到的就是“原始像素矩阵本身”，
        # 非方形像素素材会明显呈现被压扁/拉宽的样子。
        vf = (
            f"scale='min({max_side},iw)':-2:flags=fast_bilinear,"
            "setsar=1"
        )
        cmd = [
            find_ffmpeg(), "-hide_banner", "-nostdin", "-y",
            "-noautorotate", "-display_rotation", "0",
            "-i", src_path,
            "-map", "0:v:0", "-an",
            "-vf", vf,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
            out_path,
        ]
    elif mode == "display":
        out_w, out_h = geom.output_size("nearest")
        # 等比缩到 max_side 以内且保持偶数
        shrink = (
            "scale='if(gt(iw,ih),%d,-2)':'if(gt(iw,ih),-2,%d)'"
            ":flags=fast_bilinear,setsar=1" % (max_side, max_side)
        )
        vf = geom.bake_filter_chain(
            out_w, out_h, flags="fast_bilinear"
        ) + "," + shrink
        cmd = [
            find_ffmpeg(), "-hide_banner", "-nostdin", "-y",
            "-noautorotate", "-display_rotation", "0",
            "-i", src_path,
            "-map", "0:v:0", "-an",
            "-vf", vf,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
            out_path,
        ]
    else:
        raise ValueError(f"未知预览模式：{mode}")

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            "预览代理生成失败：" + "\n".join(proc.stderr.splitlines()[-8:])
        )
    return out_path
