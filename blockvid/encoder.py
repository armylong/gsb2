"""编码器: RGBA 帧序列 -> .bvd (关键帧 + 变化小块)。"""
import math

import numpy as np

from . import container
from .ffmpeg_io import decode_rgba, probe


def block_grid(width, height, bw, bh):
    cols = math.ceil(width / bw)
    rows = math.ceil(height / bh)
    for by in range(rows):
        for bx in range(cols):
            x, y = bx * bw, by * bh
            # 右/下边缘不足一块时取实际剩余尺寸
            yield x, y, min(bw, width - x), min(bh, height - y)


def changed_blocks(prev, cur, bw, bh):
    """返回 [(x, y, w, h, raw_bytes), ...]，逐块比较，边缘块尺寸自动收缩。"""
    h, w = cur.shape[:2]
    out = []
    for x, y, bw2, bh2 in block_grid(w, h, bw, bh):
        a = prev[y:y + bh2, x:x + bw2]
        b = cur[y:y + bh2, x:x + bw2]
        if not np.array_equal(a, b):
            out.append((x, y, bw2, bh2, b.tobytes()))
    return out


def encode(src_path, out_path, block_w=64, block_h=64, keyint=30,
           max_seconds=30.0, progress=None):
    """把 src_path 编码成 out_path。progress(done, total) 可选回调。
    返回统计信息 dict。"""
    info = probe(src_path)
    w, h = info["width"], info["height"]
    fps = info["fps_num"] / info["fps_den"]
    total = int(round(info["duration"] * fps)) if info["duration"] else 0

    stats = {
        "width": w, "height": h, "fps": fps,
        "frames": 0, "key_frames": 0, "delta_frames": 0,
        "key_bytes": 0, "delta_bytes": 0, "blocks_saved": 0,
        "raw_bytes": 0,
    }

    prev = None
    records = []
    for idx, (pts_ms, frame) in enumerate(decode_rgba(src_path, max_seconds)):
        stats["raw_bytes"] += frame.nbytes
        if idx % keyint == 0 or prev is None:
            payload = container.pack_key_payload(frame.tobytes())
            rec = container.write_frame_record(idx, pts_ms, container.FRAME_KEY, 0, payload)
            stats["key_frames"] += 1
            stats["key_bytes"] += len(rec)
        else:
            blocks = changed_blocks(prev, frame, block_w, block_h)
            payload = container.pack_delta_payload(blocks)
            rec = container.write_frame_record(
                idx, pts_ms, container.FRAME_DELTA, len(blocks), payload)
            stats["delta_frames"] += 1
            stats["delta_bytes"] += len(rec)
            stats["blocks_saved"] += len(blocks)
        records.append(rec)
        prev = frame
        if progress and total:
            progress(idx + 1, total)

    stats["frames"] = len(records)
    with open(out_path, "wb") as f:
        f.write(container.write_header(
            w, h, info["fps_num"], info["fps_den"],
            block_w, block_h, keyint, len(records)))
        for rec in records:
            f.write(rec)
    stats["file_bytes"] = (container.HEADER_STRUCT.size
                           + stats["key_bytes"] + stats["delta_bytes"])
    return stats
