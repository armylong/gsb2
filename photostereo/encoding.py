"""朝向图与有效掩膜的导出/回读.

方向通道约定 (写入 sidecar JSON, 也写在本文件 docstring 里):
  R 通道 = n_x * 127.5 + 127.5   (x 向右)
  G 通道 = n_y * 127.5 + 127.5   (y 向下)
  B 通道 = n_z * 255             (z 朝相机, 有效像素 n_z > 0)
  无效像素 (掩膜外) 三通道均为 0.
掩膜 PNG: 灰度, 255 = 有效, 0 = 无效/无解/低可信被剔除.

PNG 读写只用标准库 zlib + numpy, 支持本工具写出的 8 位灰度/RGB.
"""
from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

import numpy as np

CONVENTION = {
    "coordinate": "x 向右, y 向下, z 朝相机 (相机沿 -z 观察)",
    "R": "n_x * 127.5 + 127.5",
    "G": "n_y * 127.5 + 127.5",
    "B": "n_z * 255 (单位法线, n_z > 0)",
    "invalid": "无效像素 RGB = (0,0,0), 另见掩膜 PNG: 255 有效 / 0 无效",
    "light_direction": "灯方向向量从表面指向光源",
}


# ---------------- 极简 PNG 读写 ----------------

def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str | Path, image: np.ndarray) -> None:
    """写 8 位 PNG. image 形状 (H,W) 灰度或 (H,W,3) RGB, uint8."""
    image = np.asarray(image, dtype=np.uint8)
    if image.ndim == 2:
        color_type, channels = 0, 1
    elif image.ndim == 3 and image.shape[2] == 3:
        color_type, channels = 2, 3
    else:
        raise ValueError("只支持 (H,W) 灰度或 (H,W,3) RGB")
    h, w = image.shape[:2]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    flat = image.reshape(h, w * channels)
    with_filter = np.empty((h, w * channels + 1), dtype=np.uint8)
    with_filter[:, 0] = 0  # filter type 0 (None), 逐行
    with_filter[:, 1:] = flat
    idat = zlib.compress(with_filter.tobytes(), level=6)
    payload = b"\x89PNG\r\n\x1a\n"
    payload += _chunk(b"IHDR", ihdr)
    payload += _chunk(b"IDAT", idat)
    payload += _chunk(b"IEND", b"")
    Path(path).write_bytes(payload)


def read_png(path: str | Path) -> np.ndarray:
    """读 8 位非隔行 PNG (灰度/RGB), 返回 uint8."""
    raw = Path(path).read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 文件")
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(raw):
        (length,) = struct.unpack(">I", raw[pos : pos + 4])
        tag = raw[pos + 4 : pos + 8]
        data = raw[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(
                ">IIBBBBB", data
            )
            if bit_depth != 8 or interlace != 0:
                raise ValueError("只支持 8 位非隔行 PNG")
        elif tag == b"IDAT":
            idat.extend(data)
        elif tag == b"IEND":
            break
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError(f"不支持的 color_type={color_type}")
    decompressed = np.frombuffer(zlib.decompress(bytes(idat)), dtype=np.uint8)
    stride = width * channels
    rows = decompressed.reshape(height, stride + 1)
    filters = rows[:, 0]
    content = rows[:, 1:].astype(np.int32)
    # 解码 filter type 0~4
    out = np.zeros_like(content)
    prev = np.zeros(stride, dtype=np.int32)
    for y in range(height):
        cur = content[y]
        f = filters[y]
        if f == 0:
            recon = cur
        elif f == 1:  # Sub
            recon = cur.copy()
            recon[channels:] += recon[:-channels]
        elif f == 2:  # Up
            recon = cur + prev
        elif f == 3:  # Average
            recon = cur.copy()
            left = np.zeros(stride, dtype=np.int32)
            left[channels:] = recon[:-channels]
            recon += (left + prev) // 2
        elif f == 4:  # Paeth
            recon = cur.copy()
            left = np.zeros(stride, dtype=np.int32)
            up_left = np.zeros(stride, dtype=np.int32)
            left[channels:] = recon[:-channels]
            up_left[channels:] = prev[:-channels]
            p = left + prev - up_left
            pa, pb, pc = np.abs(p - left), np.abs(p - prev), np.abs(p - up_left)
            pick = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, prev, up_left))
            recon += pick
        else:
            raise ValueError(f"未知 PNG filter {f}")
        out[y] = recon
        prev = recon
    out = np.clip(out, 0, 255).astype(np.uint8).reshape(height, width, channels)
    return out[..., 0] if channels == 1 else out


# ---------------- 朝向图编解码 ----------------

def encode_normals_rgb(normals: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """单位法线 -> uint8 RGB 朝向图 (约定见模块 docstring)."""
    normals = np.asarray(normals, np.float64)
    rgb = np.empty((*normals.shape[:-1], 3), np.uint8)
    rgb[..., 0] = np.round(normals[..., 0] * 127.5 + 127.5)
    rgb[..., 1] = np.round(normals[..., 1] * 127.5 + 127.5)
    rgb[..., 2] = np.round(normals[..., 2] * 255.0)
    rgb[~np.asarray(valid, bool)] = 0
    return rgb


def decode_normals_rgb(
    rgb: np.ndarray, mask: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """朝向图 -> (单位法线, 有效掩膜). 掩膜可由独立 mask PNG 提供."""
    rgb = np.asarray(rgb, np.float64)
    nonzero = np.any(rgb > 0, axis=-1)
    valid = nonzero if mask is None else np.asarray(mask, bool)
    n = np.zeros((*rgb.shape[:-1], 3), np.float64)
    n[..., 0] = (rgb[..., 0] - 127.5) / 127.5
    n[..., 1] = (rgb[..., 1] - 127.5) / 127.5
    n[..., 2] = rgb[..., 2] / 255.0
    norms = np.linalg.norm(n, axis=-1, keepdims=True)
    n = n / np.maximum(norms, 1e-12)
    n[~valid] = 0.0
    return n, valid & nonzero


def encode_mask(valid: np.ndarray) -> np.ndarray:
    return (np.asarray(valid, bool) * 255).astype(np.uint8)


def export_result(
    out_dir: str | Path, stem: str, result, *, low_conf_threshold: float = 0.35
) -> dict[str, Path]:
    """导出朝向图 PNG、掩膜 PNG、sidecar JSON 与原始数据 npz.

    低于置信度阈值的像素也归入无效掩膜. 返回写出的文件路径字典.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    valid = result.valid & (result.confidence >= low_conf_threshold)
    normal_png = out_dir / f"{stem}_normals.png"
    mask_png = out_dir / f"{stem}_mask.png"
    sidecar = out_dir / f"{stem}_sidecar.json"
    npz = out_dir / f"{stem}_data.npz"

    write_png(normal_png, encode_normals_rgb(result.normals, valid))
    write_png(mask_png, encode_mask(valid))
    meta = {
        "stem": stem,
        "convention": CONVENTION,
        "shape": list(result.normals.shape[:2]),
        "low_conf_threshold": low_conf_threshold,
        "n_lights": int(result.directions.shape[0]),
        "saturation": result.saturation,
        "min_intensity": result.min_intensity,
        "status_legend": {
            "0": "有效",
            "1": "有效灯不足, 无解",
            "2": "灯方向过于接近, 低可信",
            "3": "模型不符, 低可信",
            "4": "法线背向相机, 无解",
            "5": "整体过暗, 无解",
            "6": "多数灯过曝, 无解",
        },
        "files": {
            "normals_png": normal_png.name,
            "mask_png": mask_png.name,
            "data_npz": npz.name,
        },
    }
    sidecar.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    np.savez_compressed(
        npz,
        normals=result.normals,
        albedo=result.albedo,
        confidence=result.confidence,
        status=result.status,
        valid=valid,
        directions=result.directions,
        strengths=result.strengths,
    )
    return {"normals": normal_png, "mask": mask_png, "sidecar": sidecar, "data": npz}


def import_normal_map(
    normal_png: str | Path, mask_png: str | Path | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """回读导出的朝向图 (掩膜可选), 用于验证导出往返."""
    rgb = read_png(normal_png)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("朝向图应为 RGB PNG")
    mask = read_png(mask_png).astype(bool) if mask_png else None
    return decode_normals_rgb(rgb, mask)
