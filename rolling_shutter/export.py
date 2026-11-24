"""短片导出与校验。

导出包为 zip，内部结构::

    manifest.json        完整参数、帧时间、像素尺寸（可逐项核对）
    frame_0000.png ...   无损 PNG 帧（自写编码器，仅依赖标准库 zlib）
    row_windows.csv      每行曝光窗/读出时刻/闪光覆盖/行均值，可逐行核对
    params.json          参数副本（含指纹）

时间与尺寸全部写在 manifest.json 中，verify_export 可重新打开导出包核对。
"""
from __future__ import annotations

import csv
import io
import json
import struct
import zipfile
import zlib
from pathlib import Path

import numpy as np

from .model import MODE_GLOBAL, MODE_ROLLING, Clip, ObjectSpec, SimParams

EXPORT_VERSION = 1


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(rgb: np.ndarray) -> bytes:
    """float [H,W,3]（取值 0..1）或 uint8 -> 无损 PNG 字节串。"""
    if rgb.dtype != np.uint8:
        arr = np.clip(rgb, 0.0, 1.0)
        arr = (arr * 255.0 + 0.5).astype(np.uint8)
    else:
        arr = rgb
    h, w, _ = arr.shape
    raw = np.empty((h, w * 3 + 1), dtype=np.uint8)
    raw[:, 0] = 0  # 每行第一个字节为 filter type 0 (None)
    raw[:, 1:] = arr.reshape(h, w * 3)
    compressed = zlib.compress(raw.tobytes(), level=6)
    png = b"\x89PNG\r\n\x1a\n"
    png += _png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += _png_chunk(b"IDAT", compressed)
    png += _png_chunk(b"IEND", b"")
    return png


def _read_png(path_or_bytes) -> tuple[int, int]:
    """只解析 IHDR 得到 (宽, 高)，用于校验导出尺寸，不依赖第三方库。"""
    if isinstance(path_or_bytes, (bytes, bytearray)):
        data = bytes(path_or_bytes)
    elif hasattr(path_or_bytes, "read"):
        data = path_or_bytes.read()
    else:
        data = Path(path_or_bytes).read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("不是合法 PNG 文件")
    w, h = struct.unpack(">II", data[16:24])
    return int(w), int(h)


def build_manifest(clip: Clip) -> dict:
    p = clip.params
    return {
        "export_version": EXPORT_VERSION,
        "mode": clip.mode,
        "signature": clip.signature,
        "timing": {
            "fps": p.fps,
            "frame_period_s": p.frame_period,
            "n_frames": p.n_frames,
            "clip_duration_s": p.clip_duration,
            "exposure_s": p.exposure,
            "total_readout_s": p.total_readout,
            "readout_direction": p.readout_direction,
            "frame_start_times_s": [round(float(t), 9)
                                    for t in clip.frame_times],
            "flash": {
                "enabled": p.flash_enabled,
                "start_s": p.flash_start,
                "duration_s": p.flash_duration,
                "intensity": p.flash_intensity,
            },
        },
        "image": {
            "width_px": p.width,
            "height_px": p.height,
            "color": "rgb8",
            "n_png_frames": int(clip.n_frames),
        },
        "params": p.to_dict(),
    }


def export_clip(clip: Clip, out_path: str | Path) -> Path:
    """把一组短片导出为 zip，返回实际路径。"""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest(clip)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json",
                    json.dumps(manifest, indent=2, ensure_ascii=False))
        zf.writestr("params.json",
                    json.dumps(clip.params.to_dict(), indent=2,
                               ensure_ascii=False))
        for fi in range(clip.n_frames):
            zf.writestr(f"frames/frame_{fi:04d}.png",
                        write_png(clip.frames[fi]))
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["frame", "row", "exposure_start_s", "exposure_end_s",
                         "readout_start_s", "flash_overlap", "row_mean"])
        for fi in range(clip.n_frames):
            for r in range(clip.params.height):
                writer.writerow([
                    fi, r,
                    f"{clip.windows[fi, r, 0]:.9f}",
                    f"{clip.windows[fi, r, 1]:.9f}",
                    f"{clip.readout_starts[fi, r]:.9f}",
                    f"{clip.flash_overlap[fi, r]:.6f}",
                    f"{clip.row_means[fi, r]:.6f}",
                ])
        zf.writestr("row_windows.csv", buf.getvalue())
    return out_path


def verify_export(path: str | Path) -> dict:
    """重新打开导出包核对：文件完整性、PNG 尺寸、帧数、时序单调性、指纹。

    返回核对报告 dict，其中 ok=True 表示全部通过。
    """
    path = Path(path)
    report: dict = {"path": str(path), "checks": [], "ok": True}

    def check(name: str, ok: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        report["ok"] = report["ok"] and bool(ok)

    try:
        with zipfile.ZipFile(path) as zf:
            bad = zf.testzip()
            check("zip 完整", bad is None, "全部条目可解压" if bad is None
                  else f"损坏条目: {bad}")
            names = set(zf.namelist())
            check("manifest.json 存在", "manifest.json" in names)
            check("row_windows.csv 存在", "row_windows.csv" in names)
            manifest = json.loads(zf.read("manifest.json"))
            p_dict = manifest["params"]
            params = SimParams(**{
                **p_dict,
                "objects": tuple(ObjectSpec(**o) for o in p_dict["objects"]),
            })
            expect_sig = params.signature()
            check("参数指纹一致", manifest["signature"] == expect_sig,
                  f"manifest={manifest['signature']} 重算={expect_sig}")

            w = manifest["image"]["width_px"]
            h = manifest["image"]["height_px"]
            n = manifest["timing"]["n_frames"]
            check("尺寸字段合法", w == params.width and h == params.height,
                  f"{w}x{h}")
            png_names = sorted(
                n for n in names if n.startswith("frames/") and n.endswith(".png"))
            check("PNG 帧数", len(png_names) == n,
                  f"实际 {len(png_names)} / 声明 {n}")
            bad_size = []
            for name in png_names:
                pw, ph = _read_png(zf.read(name))
                if (pw, ph) != (w, h):
                    bad_size.append((name, pw, ph))
            check("每帧 PNG 尺寸", not bad_size,
                  f"全部 {w}x{h}" if not bad_size else str(bad_size[:3]))

            csv_text = zf.read("row_windows.csv").decode("utf-8").splitlines()
            rows = list(csv.reader(csv_text[1:]))
            check("行记录数", len(rows) == n * h,
                  f"实际 {len(rows)} / 应为 {n * h}")
            prev_end = -1.0
            monotonic = True
            for fi in range(n):
                first = fi * h
                end0 = float(rows[first][3])
                if end0 <= prev_end:
                    monotonic = False
                prev_end = end0
            check("帧时间单调递增", monotonic)
            durations = [float(r[3]) - float(r[2]) for r in rows[:h]]
            check("曝光时长字段",
                  all(abs(d - params.exposure) < 1e-9 for d in durations),
                  f"期望 {params.exposure}s")
            manifest_dur = manifest["timing"]["clip_duration_s"]
            check("总时长 = 帧数/fps",
                  abs(manifest_dur - n / params.fps) < 1e-9,
                  f"{manifest_dur}s")
    except (zipfile.BadZipFile, KeyError, ValueError, json.JSONDecodeError) as exc:
        check("导出包可解析", False, repr(exc))
    return report
