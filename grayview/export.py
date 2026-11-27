"""导出：PNG（保留灰度精度）+ 参数说明 + 缺失掩膜；并支持重开核对像素。

有缺失区域时调用方必须显式选择处理方式，避免把未知像素当 0：

    mask 模式     缺失处写 0，但必须同时给出 mask PNG 和参数
                  （missing_policy=mask），重开时据此知道哪里是未知
    fill 模式     缺失处写明确的填充值 fill_value，同样给出 mask PNG
    none 模式     只在完全没有缺失时允许

mask PNG：8 位灰度，255=有效像素，0=未知像素。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .decode import Decoded, decode
from .layout import Interpretation
from .pngio import read_gray, write_gray

POLICIES = ("mask", "fill", "none")


class ExportError(ValueError):
    pass


@dataclass
class ExportResult:
    png_path: Path
    params_path: Path
    mask_path: Path | None
    bit_depth: int
    missing_pixels: int
    policy: str
    fill_value: int | None


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def default_bit_depth(dec: Decoded) -> int:
    """保留原始灰度精度：8 位用 8；12/16 位用 16 位 PNG。"""
    return 8 if dec.interp.bpp == 8 else 16


def export(
    dec: Decoded,
    out_dir: str | Path,
    *,
    stem: str,
    bit_depth: int | None = None,
    missing_policy: str | None = None,
    fill_value: int = 0,
    source_path: str | Path | None = None,
) -> ExportResult:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    has_missing = dec.missing_count > 0

    if has_missing:
        if missing_policy is None:
            raise ExportError(
                "图像有缺失像素，必须显式选择 missing_policy："
                "'mask'（缺失处写 fill_value 并另存掩膜）或 'fill'"
                "（明确填充并与掩膜并存）；不允许默认把缺失当灰度 0"
            )
        if missing_policy not in POLICIES:
            raise ExportError(f"missing_policy 只能是 {POLICIES}，收到 {missing_policy!r}")
        if missing_policy == "none":
            raise ExportError("存在缺失像素，不能使用 'none' 策略")
        if not (0 <= int(fill_value) <= dec.max_value):
            raise ExportError(f"fill_value 超出 0..{dec.max_value}")
        effective_fill = int(fill_value) if missing_policy == "fill" else 0
    else:
        if missing_policy not in (None, "none"):
            raise ExportError("图像没有缺失像素，不需要缺失策略")
        missing_policy = "none"
        effective_fill = None

    if bit_depth is None:
        bit_depth = default_bit_depth(dec)
    if bit_depth not in (8, 16):
        raise ExportError("bit_depth 只能是 8 或 16")

    values = dec.values.copy()
    if has_missing:
        values[~dec.valid] = np.uint16(effective_fill)
    arr = values.astype(np.uint16)
    if bit_depth == 8 and arr.size and int(arr.max()) > 255:
        raise ExportError("8 位导出会截断灰度，请用 16 位")

    png_path = out / f"{stem}.png"
    mask_path = out / f"{stem}.mask.png"
    params_path = out / f"{stem}.params.json"

    text = {
        "gsbraw_params": json.dumps(dec.interp.as_dict(), ensure_ascii=False),
        "gsbraw_missing_policy": missing_policy,
        "gsbraw_missing_pixels": str(dec.missing_count),
    }
    info = write_gray(png_path, arr, bit_depth=bit_depth, text=text)
    if has_missing:
        mask_arr = np.where(dec.valid, 255, 0).astype(np.uint8)
        write_gray(
            mask_path, mask_arr, bit_depth=8, text={"gsbraw_mask": "255=valid,0=unknown"}
        )
    else:
        mask_path = None

    meta = {
        "format": "gsbraw-export-v1",
        "params": dec.interp.as_dict(),
        "params_explain": dec.interp.summary_lines(),
        "file_size": dec.file_size,
        "required_bytes": dec.layout.required_bytes,
        "width": dec.width,
        "height": dec.height,
        "source_file": str(Path(source_path).resolve()) if source_path else None,
        "source_sha256": _digest(Path(source_path)) if source_path else None,
        "png": png_path.name,
        "png_bit_depth": info["bit_depth"],
        "mask_png": mask_path.name if mask_path else None,
        "mask_semantics": "255=有效像素, 0=未知像素" if mask_path else None,
        "missing_policy": missing_policy,
        "fill_value": effective_fill,
        "missing_pixels": dec.missing_count,
        "present_pixels": int(dec.valid.sum()),
        "partial_rows": dec.layout.partial_rows,
        "absent_rows": dec.layout.absent_rows,
        "extra_start": dec.layout.extra_start,
        "extra_bytes": dec.layout.extra_bytes,
        "row_layout": [
            {
                "row": rl.row,
                "start": rl.start,
                "row_bytes": rl.row_bytes,
                "tail": rl.tail,
                "gap_start": rl.gap_start,
                "gap_end": rl.gap_end,
                "gap": rl.gap,
                "available": rl.available,
                "complete_pixels": rl.complete_pixels,
                "status": rl.status,
            }
            for rl in dec.layout.rows
        ],
        "values_semantics": "灰度值为原始位深数值，未做归一化",
    }
    params_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return ExportResult(
        png_path=png_path,
        params_path=params_path,
        mask_path=mask_path,
        bit_depth=info["bit_depth"],
        missing_pixels=dec.missing_count,
        policy=missing_policy,
        fill_value=effective_fill,
    )


@dataclass
class VerifyResult:
    ok: bool
    rows: int
    cols: int
    checked: int
    mismatched: int
    mismatches: list[tuple[int, int, int, int]] = field(default_factory=list)
    mode: str = ""
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.ok:
            return f"通过：{self.mode}，{self.checked} 个像素一致"
        lines = [f"不一致：{self.mismatched}/{self.checked}（{self.mode}）"]
        for r, c, want, got in self.mismatches[:10]:
            lines.append(f"  ({r},{c}) 期望 {want} 实读 {got}")
        return "\n".join(lines)


def verify_export(
    png_path: str | Path,
    params_path: str | Path | None = None,
    *,
    original: Decoded | None = None,
    sample: int = 0,
) -> VerifyResult:
    """重开导出的 PNG 并核对像素。

    - 掩膜：若参数记录中有 mask_png，逐像素比对掩膜与原始有效位；
    - 有效像素：与原始解码灰度逐像素比对；
    - 缺失像素：复核 PNG 里的填值与参数记录的 fill_value 一致。
    没有传入 original 时，用参数 JSON 里的 source_file 重新解码源文件。
    """
    png_path = Path(png_path)
    png = read_gray(str(png_path))
    meta_path = Path(params_path) if params_path else png_path.with_suffix(".params.json")
    meta: dict = {}
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    notes: list[str] = []

    if original is None:
        src = meta.get("source_file")
        if not src:
            return VerifyResult(
                False, png.height, png.width, 0, 0, mode="缺少原始解码结果",
                notes=["参数文件没有 source_file，无法重算原始灰度"],
            )
        src_path = Path(src)
        if not src_path.exists():
            return VerifyResult(
                False, png.height, png.width, 0, 0, mode="源文件不可达",
                notes=[f"参数记录的 source_file 不存在：{src_path}"],
            )
        if meta.get("source_sha256"):
            if _digest(src_path) != meta["source_sha256"]:
                notes.append("源文件 sha256 与导出时记录不一致，按当前内容核对")
        interp = Interpretation.from_dict(meta["params"])
        original = decode(src_path.read_bytes(), interp)

    if (png.height, png.width) != (original.height, original.width):
        return VerifyResult(
            False, png.height, png.width, 0, 0, mode="尺寸不符",
            notes=[f"PNG {(png.height, png.width)} vs 解码 {(original.height, original.width)}"],
        )
    if meta.get("png_bit_depth") and int(meta["png_bit_depth"]) != png.bit_depth:
        notes.append(f"PNG 位深 {png.bit_depth} 与参数记录 {meta['png_bit_depth']} 不符")

    mask = None
    mask_name = meta.get("mask_png")
    if mask_name:
        mask_img = read_gray(str(png_path.parent / mask_name))
        mask = mask_img.array.astype(bool)
        if mask.shape != png.array.shape:
            return VerifyResult(
                False, png.height, png.width, 0, 0, mode="掩膜尺寸不符"
            )

    rows, cols = png.array.shape
    if sample and sample > 0:
        rng = np.random.default_rng(0)
        n = min(sample, rows * cols)
        flat = rng.choice(rows * cols, size=n, replace=False)
        coords = [(int(i // cols), int(i % cols)) for i in flat]
        mode = f"随机抽检 {n} 像素"
    else:
        coords = [(r, c) for r in range(rows) for c in range(cols)]
        mode = "全图逐像素"

    fill_value = meta.get("fill_value")
    mismatches: list[tuple[int, int, int, int]] = []
    checked = 0
    for r, c in coords:
        checked += 1
        valid = bool(original.valid[r, c])
        if mask is not None and bool(mask[r, c]) != valid:
            mismatches.append((r, c, int(valid), int(mask[r, c])))
            continue
        got = int(png.array[r, c])
        if valid:
            want = int(original.values[r, c])
            if want != got:
                mismatches.append((r, c, want, got))
        elif fill_value is not None and got != int(fill_value):
            mismatches.append((r, c, int(fill_value), got))
    return VerifyResult(
        ok=not mismatches,
        rows=rows,
        cols=cols,
        checked=checked,
        mismatched=len(mismatches),
        mismatches=mismatches[:20],
        mode=mode,
        notes=notes,
    )
