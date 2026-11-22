"""逐像素核对与帧导出。PNG 写出用纯 Python 实现, CLI 无需 Qt。"""
import struct
import zlib

import numpy as np

from .decoder import Decoder
from .ffmpeg_io import decode_rgba


def save_png(path, rgba: np.ndarray):
    h, w = rgba.shape[:2]
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # RGBA8
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 6)))
        f.write(chunk(b"IEND", b""))


def compare_frames(a: np.ndarray, b: np.ndarray):
    """返回 (是否一致, 不同像素数, 最大通道差)。"""
    if a.shape != b.shape:
        return False, -1, -1
    diff = a.astype(np.int16) - b.astype(np.int16)
    nz = np.count_nonzero(np.any(diff != 0, axis=2))
    return bool(nz == 0), int(nz), int(np.abs(diff).max()) if nz else 0


def verify(bvd_path, src_path, max_seconds=30.0, progress=None):
    """把 .bvd 全部帧与源视频 ffmpeg 解码结果逐像素对比(无损校验)。"""
    dec = Decoder(bvd_path)
    report = {"total": 0, "mismatch": [], "corrupt": [],
              "max_channel_diff": 0}
    for idx, (_pts, ref) in enumerate(decode_rgba(src_path, max_seconds)):
        if idx > dec.max_frame:
            break
        try:
            got = dec.get_frame(idx)
        except Exception as e:
            report["corrupt"].append((idx, str(e)))
            continue
        same, nz, mx = compare_frames(got, ref)
        report["total"] += 1
        if not same:
            report["mismatch"].append((idx, nz, mx))
            report["max_channel_diff"] = max(report["max_channel_diff"], mx)
        if progress:
            progress(idx + 1)
    return report


def export_frames(bvd_path, out_dir, frame_indices, src_path=None,
                  max_seconds=30.0):
    """导出还原帧为 PNG; 给 src_path 时同时导出源帧和对比结果。"""
    import os
    os.makedirs(out_dir, exist_ok=True)
    dec = Decoder(bvd_path)
    refs = {}
    if src_path:
        for idx, (_pts, ref) in enumerate(decode_rgba(src_path, max_seconds)):
            if idx in frame_indices:
                refs[idx] = ref
            if idx > max(frame_indices):
                break
    results = []
    for idx in frame_indices:
        got = dec.get_frame(idx)
        p = os.path.join(out_dir, f"restored_{idx:05d}.png")
        save_png(p, got)
        row = {"frame": idx, "restored": p}
        if idx in refs:
            rp = os.path.join(out_dir, f"source_{idx:05d}.png")
            save_png(rp, refs[idx])
            same, nz, mx = compare_frames(got, refs[idx])
            row.update({"source": rp, "identical": same,
                        "diff_pixels": nz, "max_channel_diff": mx})
        results.append(row)
    return results
