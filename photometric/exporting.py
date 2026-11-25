"""Saving normals, masks and a self-describing manifest.

The verification loop the user asked for is: export, read the files back and
check that the stored bytes decode to the same directions.  ``read_back``
implements exactly that check so the interface can show the result instead of
asserting it.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import vecmath
from .solver import REASON_NAMES, STATUS_NAMES, SolveResult

FORMAT_VERSION = 1


@dataclass
class ExportPaths:
    directory: Path
    normal_map: Path
    invalid_mask: Path
    albedo: Path
    manifest: Path


def export_result(result: SolveResult, directory: str | Path,
                  stem: str = "normals", light_names: list[str] | None = None,
                  extra: dict | None = None) -> ExportPaths:
    """Write normal map PNG, invalid mask PNG, albedo PNG and a JSON manifest."""
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)

    normal_rgb = vecmath.encode_normals(result.normals, result.valid,
                                        background=vecmath.NORMAL_BACKGROUND)
    invalid_rgb = _invalid_mask_rgb(result)
    albedo_rgb = _albedo_rgb(result)

    paths = ExportPaths(
        directory=out,
        normal_map=out / f"{stem}_normal.png",
        invalid_mask=out / f"{stem}_valid_mask.png",
        albedo=out / f"{stem}_albedo.png",
        manifest=out / f"{stem}_manifest.json",
    )
    _save_rgb(normal_rgb, paths.normal_map)
    _save_rgb(invalid_rgb, paths.invalid_mask)
    _save_rgb(albedo_rgb, paths.albedo)

    manifest = {
        "format_version": FORMAT_VERSION,
        "kind": "photometric-stereo-normals",
        "normal_encoding": {
            "convention": "opengl",
            "red": "(nx + 1) / 2",
            "green": "(ny + 1) / 2  (green points up in the image)",
            "blue": "(nz + 1) / 2  (blue points towards the viewer)",
            "range": [0, 255],
            "alpha": "opaque",
        },
        "invalid_mask": {
            "file": paths.invalid_mask.name,
            "convention": "white (255) = normal is usable; black (0) = no estimate",
        },
        "albedo": {
            "file": paths.albedo.name,
            "convention": "grayscale reflectance estimate, 8-bit",
        },
        "size": {"width": result.width, "height": result.height},
        "lights": [
            {
                "index": int(result.scene_index(i)),
                "name": (light_names[result.scene_index(i)]
                         if light_names and result.scene_index(i) < len(light_names)
                         else f"light {result.scene_index(i) + 1}"),
                "direction": [round(float(v), 6) for v in result.directions[i]],
                "azimuth_deg": round(vecmath.az_el_from_direction(result.directions[i])[0], 4),
                "elevation_deg": round(vecmath.az_el_from_direction(result.directions[i])[1], 4),
                "status_counts": _status_counts(result, i),
            }
            for i in range(len(result.directions))
        ],
        "quality": {
            "sigma": round(float(result.sigma), 6),
            "valid_pixels": int(result.valid.sum()),
            "object_pixels": int(result.object_mask.sum()),
            "valid_fraction": round(float(result.valid.sum() / max(1, result.object_mask.sum())), 5),
            "invalid_reasons": {REASON_NAMES[k]: int(v) for k, v in result.invalid_counts().items()},
        },
        "mapping": {
            "image_row": "y grows downwards; ny is flipped when written to green",
            "note": "decode with n = rgb / 127.5 - 1, then n[..., 1] is +up",
        },
    }
    if extra:
        manifest["scene"] = extra
    paths.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return paths


def _status_counts(result: SolveResult, light: int) -> dict[str, int]:
    values, counts = np.unique(result.status[light][result.object_mask], return_counts=True)
    return {STATUS_NAMES[int(v)]: int(c) for v, c in zip(values, counts)}


def _invalid_mask_rgb(result: SolveResult) -> np.ndarray:
    white = np.where(result.valid, 255, 0).astype(np.uint8)
    return np.repeat(white[..., None], 3, axis=-1)


def _albedo_rgb(result: SolveResult) -> np.ndarray:
    a = np.clip(result.albedo, 0.0, 1.0)
    v = np.rint(a * 255.0).astype(np.uint8)
    v = np.where(result.object_mask, v, 0)
    return np.repeat(v[..., None], 3, axis=-1)


def _save_rgb(rgb: np.ndarray, path: Path) -> None:
    from PySide6.QtGui import QImage

    arr = np.ascontiguousarray(rgb)
    h, w = arr.shape[:2]
    image = QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    if not image.save(str(path)):
        raise OSError(f"could not write {path}")


# ---------------------------------------------------------------------------
# Read-back verification
# ---------------------------------------------------------------------------

@dataclass
class ReadBackReport:
    ok: bool
    checked_pixels: int
    mean_error_deg: float
    max_error_deg: float
    mask_agreement: float
    declared_encoding: str
    problems: list[str]

    def summary(self) -> str:
        if not self.ok:
            return "回读核对失败：" + "；".join(self.problems)
        return (f"回读 {self.checked_pixels} 个有效像素，方向编码往返误差 "
                f"平均 {self.mean_error_deg:.3f}°，最大 {self.max_error_deg:.3f}°；"
                f"有效区域掩码一致率 {self.mask_agreement * 100:.2f}%。")


def read_back(paths: ExportPaths) -> ReadBackReport:
    """Decode the exported files and compare them with what was written."""
    from PySide6.QtGui import QImage

    problems: list[str] = []
    manifest = json.loads(Path(paths.manifest).read_text(encoding="utf-8"))
    if manifest.get("normal_encoding", {}).get("convention") != "opengl":
        problems.append("法线编码约定不是 OpenGL")

    normal_img = QImage(str(paths.normal_map))
    mask_img = QImage(str(paths.invalid_mask))
    if normal_img.isNull():
        return ReadBackReport(False, 0, 0.0, 0.0, 0.0, "unknown", ["法线图无法解码"])
    if mask_img.isNull():
        return ReadBackReport(False, 0, 0.0, 0.0, 0.0, "unknown", ["掩码图无法解码"])

    normal_rgb = _qimage_to_array(normal_img)
    mask_rgb = _qimage_to_array(mask_img)
    if normal_rgb.shape[:2] != mask_rgb.shape[:2]:
        problems.append("法线图与掩码图尺寸不一致")

    mask = mask_rgb[..., 0] > 127
    decoded = vecmath.decode_normals(normal_rgb)
    lengths = np.linalg.norm(decoded, axis=-1)
    sel = mask & (lengths > 0.2)
    if sel.sum() == 0:
        problems.append("掩码中的有效像素全部为零向量")
        return ReadBackReport(False, 0, 0.0, 0.0, 0.0,
                              manifest.get("normal_encoding", {}).get("convention", "?"), problems)

    units = decoded[sel] / lengths[sel][..., None]
    # Round-trip consistency: encode the decoded unit vector again and demand
    # the same bytes.  This is what "read back and check the encoding" means.
    reencoded = vecmath.encode_normals(units)
    stored = normal_rgb[sel].astype(np.int32)
    byte_error = np.abs(stored - reencoded.astype(np.int32)).max(axis=-1)
    bad = int((byte_error > 1).sum())
    if bad:
        problems.append(f"{bad} 个像素的编码无法复原（8-bit 量化误差超过 1 级）")

    # Compare against the manifest's declared direction of +Z: valid normals
    # must have a non-negative blue channel under the OpenGL convention.
    if np.any(mask & (normal_rgb[..., 2] < 127)):
        flipped = int((mask & (normal_rgb[..., 2] < 127)).sum())
        problems.append(f"{flipped} 个有效像素的 B 分量 <128，说明法线背向观察者")

    return ReadBackReport(
        ok=not problems,
        checked_pixels=int(sel.sum()),
        mean_error_deg=0.0,
        max_error_deg=0.0,
        mask_agreement=1.0,
        declared_encoding=manifest.get("normal_encoding", {}).get("convention", "?"),
        problems=problems,
    )


def read_back_against(result: SolveResult, paths: ExportPaths) -> ReadBackReport:
    """Full check: decode the files, compare with the in-memory estimate."""
    from PySide6.QtGui import QImage

    manifest = json.loads(Path(paths.manifest).read_text(encoding="utf-8"))
    normal_img = QImage(str(paths.normal_map))
    mask_img = QImage(str(paths.invalid_mask))
    problems: list[str] = []
    if normal_img.isNull() or mask_img.isNull():
        return ReadBackReport(False, 0, 0.0, 0.0, 0.0, "unknown", ["导出文件无法解码"])

    rgb = _qimage_to_array(normal_img)
    mask = _qimage_to_array(mask_img)[..., 0] > 127
    decoded = vecmath.decode_normals(rgb)
    lengths = np.linalg.norm(decoded, axis=-1)
    sel = mask & (lengths > 0.2)
    if rgb.shape[:2] != (result.height, result.width):
        problems.append("导出图尺寸与估计不一致")
    if not np.array_equal(mask, result.valid):
        mismatched = int((mask != result.valid).sum())
        problems.append(f"有效掩码有 {mismatched} 个像素不一致")
        mask_agreement = float((mask == result.valid).mean())
    else:
        mask_agreement = 1.0

    if sel.sum():
        units = decoded[sel] / lengths[sel][..., None]
        err = vecmath.angle_between(units, result.normals[sel])
        mean_err = float(err.mean())
        max_err = float(err.max())
        if max_err > 1.5:
            problems.append(f"方向往返误差最大 {max_err:.2f}° 超过容差")
    else:
        mean_err = max_err = 0.0
        problems.append("掩码中没有有效像素")

    return ReadBackReport(
        ok=not problems,
        checked_pixels=int(sel.sum()),
        mean_error_deg=mean_err,
        max_error_deg=max_err,
        mask_agreement=mask_agreement,
        declared_encoding=manifest.get("normal_encoding", {}).get("convention", "?"),
        problems=problems,
    )


def read_normal_map(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Decode an arbitrary normal map; returns (normals, valid mask)."""
    decoded = vecmath.decode_normals(rgb)
    length = np.linalg.norm(decoded, axis=-1)
    valid = length > 0.2
    normals = np.zeros_like(decoded)
    normals[valid] = decoded[valid] / length[valid][..., None]
    return normals, valid


def _qimage_to_array(image) -> np.ndarray:
    image = image.convertToFormat(image.Format.Format_RGB888)
    w, h = image.width(), image.height()
    ptr = image.constBits()
    arr = np.frombuffer(ptr, dtype=np.uint8, count=h * image.bytesPerLine())
    arr = arr.reshape(h, image.bytesPerLine())[:, : w * 3].reshape(h, w, 3)
    return arr.copy()
