"""参考色卡数据的读取与保存。

本地文件格式（CSV，逗号分隔，# 开头为注释，UTF-8）::

    id,r,g,b
    A1,218,112,48
    A2,96,200,240

r/g/b 为参考色卡的 sRGB 8bit 目标值。也允许额外的 name 列（可选）。
"""

from __future__ import annotations

import csv
from dataclasses import dataclass

from . import srgb


@dataclass(frozen=True)
class ReferencePatch:
    """一个参考色格。rgb 为 sRGB 0-255 目标值，lab 为对应 CIELAB。"""

    id: str
    rgb: tuple[float, float, float]
    name: str = ""

    @property
    def lab(self) -> tuple[float, float, float]:
        return srgb.srgb_to_lab(self.rgb)


class ReferenceError(ValueError):
    """参考色卡文件内容不合法。"""


def _parse_rgb_field(text: str, line_no: int, field: str, id_: str) -> float:
    try:
        value = float(text)
    except ValueError as exc:
        raise ReferenceError(
            f"第 {line_no} 行色格 {id_!r} 的 {field} 不是数字: {text!r}"
        ) from exc
    if not 0.0 <= value <= 255.0:
        raise ReferenceError(
            f"第 {line_no} 行色格 {id_!r} 的 {field}={value} 超出 0-255"
        )
    return value


def load_reference(path: str) -> list[ReferencePatch]:
    """从本地 CSV 文件读取参考色卡。"""
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))

    # 先过滤整行注释与空行，再把第一行视为表头
    rows = [
        row for row in rows
        if row and any(cell.strip() for cell in row) and not row[0].strip().startswith("#")
    ]
    if not rows:
        raise ReferenceError("参考文件为空")

    header = [h.strip().lower() for h in rows[0]]
    required = ["id", "r", "g", "b"]
    for col in required:
        if col not in header:
            raise ReferenceError(f"参考文件表头缺少列 {col!r}，实际表头: {rows[0]}")
    idx = {col: header.index(col) for col in required}
    name_idx = header.index("name") if "name" in header else None

    patches: list[ReferencePatch] = []
    seen: set[str] = set()
    for line_no, raw in enumerate(rows[1:], start=2):
        if not raw or not any(cell.strip() for cell in raw):
            continue
        if raw[0].strip().startswith("#"):
            continue
        if len(raw) <= max(idx.values()):
            raise ReferenceError(f"第 {line_no} 行列数不足: {raw}")
        id_ = raw[idx["id"]].strip()
        if not id_:
            raise ReferenceError(f"第 {line_no} 行缺少色格编号")
        if id_ in seen:
            raise ReferenceError(f"色格编号 {id_!r} 重复出现")
        seen.add(id_)
        rgb = (
            _parse_rgb_field(raw[idx["r"]], line_no, "r", id_),
            _parse_rgb_field(raw[idx["g"]], line_no, "g", id_),
            _parse_rgb_field(raw[idx["b"]], line_no, "b", id_),
        )
        name = raw[name_idx].strip() if name_idx is not None and name_idx < len(raw) else ""
        patches.append(ReferencePatch(id=id_, rgb=rgb, name=name))

    if len(patches) < 3:
        raise ReferenceError("参考色卡至少需要 3 个色格才能拟合颜色修正")
    return patches


def save_reference(path: str, patches: list[ReferencePatch]) -> None:
    """把参考色卡写回 CSV（供 GUI 内修改目标色后保存）。"""
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "r", "g", "b", "name"])
        for p in patches:
            writer.writerow([
                p.id,
                f"{p.rgb[0]:.3f}",
                f"{p.rgb[1]:.3f}",
                f"{p.rgb[2]:.3f}",
                p.name,
            ])
