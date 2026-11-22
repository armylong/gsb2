"""生成合成测试短片(一个移动小图形)和损坏副本。"""
import os
import subprocess

import numpy as np

from . import container


def make_synth(out_path, width=640, height=360, fps=30, seconds=5,
               box=48, codec="libx264"):
    """深色静止背景 + 一个沿李萨如轨迹移动的亮色方块, 用 ffmpeg 编码成 mp4。"""
    n = int(fps * seconds)
    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}",
         "-r", str(fps), "-i", "-",
         "-c:v", codec, "-pix_fmt", "yuv420p", "-crf", "18", out_path],
        stdin=subprocess.PIPE)
    bg = np.zeros((height, width, 4), dtype=np.uint8)
    bg[..., 0] = 24
    bg[..., 1] = 28
    bg[..., 2] = 40
    bg[..., 3] = 255
    # 背景上画几条静止参考线, 便于观察“只有小块在变”
    bg[height // 2, :, :3] = (50, 55, 70)
    bg[:, width // 3, :3] = (50, 55, 70)
    for i in range(n):
        t = i / fps
        cx = int((width - box) * (0.5 + 0.4 * np.sin(2 * np.pi * t / seconds)))
        cy = int((height - box) * (0.5 + 0.4 * np.sin(4 * np.pi * t / seconds)))
        frame = bg.copy()
        frame[cy:cy + box, cx:cx + box, 0] = 240
        frame[cy:cy + box, cx:cx + box, 1] = 120
        frame[cy:cy + box, cx:cx + box, 2] = 40
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg 编码合成片失败")
    return out_path


def make_corrupt_copy(bvd_path, out_path=None, mode="zero"):
    """把一条增量帧记录的 payload 破坏, 生成故障演示副本。
    mode: "zero" 填零 / "truncate" 截断该记录尾部。"""
    with open(bvd_path, "rb") as f:
        buf = bytearray(f.read())
    header = container.read_header(buf[:container.HEADER_STRUCT.size])
    # 找一条居中的增量帧记录
    off = container.HEADER_STRUCT.size
    target = None
    while off < len(buf):
        try:
            rec, next_off = container.parse_frame_record(buf, off)
        except ValueError:
            break
        if (rec["frame_type"] == container.FRAME_DELTA
                and rec["frame_index"] > header["keyint"]
                and target is None):
            target = rec
            break
        off = next_off
    if target is None:
        raise ValueError("没找到可破坏的增量帧记录")
    payload_off = target["offset"] + container.FRAME_STRUCT.size
    if mode == "zero":
        for i in range(target["payload_len"]):
            buf[payload_off + i] = 0
    elif mode == "truncate":
        del buf[payload_off + target["payload_len"] // 2:
                payload_off + target["payload_len"]]
    else:
        raise ValueError(mode)
    if out_path is None:
        root, ext = os.path.splitext(bvd_path)
        out_path = root + ".corrupt" + ext
    with open(out_path, "wb") as f:
        f.write(buf)
    return out_path, target["frame_index"]
