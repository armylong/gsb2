"""用 ffmpeg 把任意视频解码成统一 RGBA 原始帧。"""
import json
import subprocess

import numpy as np


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,duration",
         "-of", "json", path],
        capture_output=True, check=True, text=True,
    ).stdout
    st = json.loads(out)["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    return {
        "width": int(st["width"]),
        "height": int(st["height"]),
        "fps_num": int(num),
        "fps_den": int(den),
        "duration": float(st.get("duration", 0.0)),
    }


def decode_rgba(path, max_seconds=30.0):
    """生成器: 逐帧产出 (pts_ms, np.ndarray[H, W, 4] uint8)。统一转成 RGBA。"""
    info = probe(path)
    w, h = info["width"], info["height"]
    fps = info["fps_num"] / info["fps_den"]
    n_frames = int(round(info["duration"] * fps)) if info["duration"] else 0
    if info["duration"] and info["duration"] > max_seconds + 1.0 / max(fps, 1):
        raise ValueError(f"视频超过 {max_seconds:.0f}s 限制 ({info['duration']:.1f}s)")
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", path,
         "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        stdout=subprocess.PIPE,
    )
    frame_size = w * h * 4
    idx = 0
    while True:
        buf = b""
        while len(buf) < frame_size:
            chunk = proc.stdout.read(frame_size - len(buf))
            if not chunk:
                break
            buf += chunk
        if len(buf) < frame_size:
            break
        pts_ms = int(round(idx * 1000.0 * info["fps_den"] / info["fps_num"]))
        yield pts_ms, np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4).copy()
        idx += 1
    proc.stdout.close()
    proc.wait()
