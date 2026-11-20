"""JSON export / import and raster preview export.

The JSON file is self-contained and reloadable:

.. code-block:: json

    {
      "format": "pathcheck.boundaries",
      "version": 1,
      "image": {"width": 96, "height": 96, "origin": "pixel corners, y down"},
      "params": {"method": "rdp", "epsilon": 1.0, ...},
      "rings": [
        {"comp": 1, "kind": "outer", "index": 0,
         "points": [[x, y], ...], "closed": true,
         "border_spans": [["top", 36, 57]]}
      ]
    }

Coordinates are integer pixel corners.  ``closed`` means the implicit closing
edge from the last point to the first is part of the path; importers must not
receive an extra repeated point.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from .geometry import Point

FORMAT = "pathcheck.boundaries"
VERSION = 1


@dataclass
class ExportedRing:
    comp: int
    kind: str
    index: int
    points: list[Point]
    border_spans: list[tuple[str, int, int]]

    @property
    def label(self) -> str:
        return f"C{self.comp}/{'O' if self.kind == 'outer' else f'H{self.index}'}"


@dataclass
class ExportDocument:
    width: int
    height: int
    rings: list[ExportedRing]
    params: dict[str, Any]
    validations: dict[str, Any]
    meta: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": FORMAT,
            "version": VERSION,
            "image": {
                "width": self.width,
                "height": self.height,
                "origin": "pixel corners, x right, y down",
                "fill_rule": "even-odd",
            },
            "params": self.params,
            "validations": self.validations,
            "rings": [
                {
                    "comp": r.comp,
                    "kind": r.kind,
                    "index": r.index,
                    "points": [[int(x), int(y)] for x, y in r.points],
                    "closed": True,
                    "border_spans": [list(s) for s in r.border_spans],
                }
                for r in self.rings
            ],
            "meta": self.meta,
        }


def write_json(doc: ExportDocument, path: str) -> None:
    payload = json.dumps(doc.to_dict(), ensure_ascii=False, indent=1, sort_keys=False)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(payload)
        fh.write("\n")


def read_json(path: str) -> ExportDocument:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("format") != FORMAT:
        raise ValueError(f"不是 pathcheck 边界文件 (format={data.get('format')!r})")
    version = data.get("version")
    if version != VERSION:
        raise ValueError(f"不支持的版本 {version!r} (期望 {VERSION})")
    image = data.get("image", {})
    rings = []
    for item in data.get("rings", []):
        pts = [tuple(int(v) for v in p) for p in item["points"]]
        if item.get("closed", True) and len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        rings.append(
            ExportedRing(
                comp=int(item["comp"]),
                kind=str(item["kind"]),
                index=int(item.get("index", 0)),
                points=pts,
                border_spans=[tuple(s) for s in item.get("border_spans", [])],
            )
        )
    return ExportDocument(
        width=int(image["width"]),
        height=int(image["height"]),
        rings=rings,
        params=dict(data.get("params", {})),
        validations=dict(data.get("validations", {})),
        meta=dict(data.get("meta", {})),
    )


def write_raster(mask: np.ndarray, path: str) -> None:
    """Write a 0/255 PNG preview (extension decides the codec)."""
    ok, buf = cv2.imencode(_ext(path), (mask != 0).astype(np.uint8) * 255)
    if not ok:
        raise ValueError(f"无法编码图像: {path}")
    buf.tofile(path)


def write_rgb(img: np.ndarray, path: str) -> None:
    """Write an RGB (or grey) preview PNG; input is RGB, OpenCV writes BGR."""
    if img.ndim == 3:
        data = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    else:
        data = img
    ok, buf = cv2.imencode(_ext(path), data)
    if not ok:
        raise ValueError(f"无法编码图像: {path}")
    buf.tofile(path)


def _ext(path: str) -> str:
    dot = path.rfind(".")
    return path[dot:] if dot >= 0 else ".png"
