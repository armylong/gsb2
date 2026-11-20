"""Export dialog: write the four filtered results plus a manifest and the
diagnostic sweeps for the current region.

Quantities that end up in the manifest are the same ones shown in the table,
so an exported run can be diffed against the reference suite.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
)

from . import core, samples


class ExportDialog(QDialog):
    def __init__(self, tab, parent=None):
        super().__init__(parent)
        self.tab = tab
        self.setWindowTitle("导出当前结果")
        self.resize(560, 420)

        layout = QVBoxLayout(self)
        form = QFormLayout()

        row = QHBoxLayout()
        self.path_edit = QLineEdit(self._suggest_path())
        browse = QPushButton("浏览…")
        browse.clicked.connect(self._browse)
        row.addWidget(self.path_edit, 1)
        row.addWidget(browse, 0)
        form.addRow("输出目录", row)

        self.check_png = QCheckBox("四滤波结果 PNG + 放大预览")
        self.check_png.setChecked(True)
        self.check_json = QCheckBox("summary.json (区域、指标、像素值)")
        self.check_json.setChecked(True)
        self.check_sweep = QCheckBox("sweep.csv (缩放与偏移曲线)")
        self.check_sweep.setChecked(True)
        form.addRow("内容", self.check_png)
        form.addRow("", self.check_json)
        form.addRow("", self.check_sweep)

        self.pixels_edit = QLineEdit("0,0; 1,1")
        form.addRow("指定像素 (x,y; …)", self.pixels_edit)
        self.zoom = QLineEdit("16")
        form.addRow("预览放大倍数", self.zoom)
        layout.addLayout(form)

        hint = QLabel(
            "半透明斜线、奇数比率网格可在样例下拉框选择后导出；指定像素的输出坐标"
            "以导出时的输出尺寸为准。"
        )
        hint.setWordWrap(True)
        layout.addWidget(hint)
        layout.addStretch(1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Cancel
            | QDialogButtonBox.StandardButton.Ok
        )
        buttons.accepted.connect(self._run)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    # ------------------------------------------------------------------ #
    def _suggest_path(self) -> str:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        return os.path.abspath(os.path.join(os.getcwd(), f"resample-export-{stamp}"))

    def _browse(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "选择输出目录", self.path_edit.text())
        if path:
            self.path_edit.setText(os.path.join(path, os.path.basename(self.path_edit.text())))

    def _parse_pixels(self, width: int, height: int) -> list[tuple[int, int]]:
        out: list[tuple[int, int]] = []
        for chunk in self.pixels_edit.text().replace(";", ",").split(","):
            chunk = chunk.strip()
            if chunk:
                try:
                    out.append(int(chunk))
                except ValueError:
                    pass
        pairs = []
        for i in range(0, len(out) - 1, 2):
            x, y = out[i], out[i + 1]
            pairs.append((min(max(x, 0), width - 1), min(max(y, 0), height - 1)))
        return pairs

    def _run(self) -> None:
        directory = self.path_edit.text().strip()
        if not directory:
            return
        os.makedirs(directory, exist_ok=True)
        image = self.tab.current_image()
        crop = self.tab.current_crop()
        out_size = self.tab.current_out_size()
        premul = self.tab.premultiply.isChecked()
        results = core.resample_all(image, crop, out_size, premul)

        zoom = max(1, int(self.zoom.text() or "1"))
        pixels = self._parse_pixels(*out_size)

        manifest = {
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "sample": self.tab.sample_key(),
            "sample_name": samples.SAMPLES[self.tab.sample_key()][0],
            "source_size": [int(image.shape[1]), int(image.shape[0])],
            "crop": {
                "x0": crop.x0,
                "y0": crop.y0,
                "width": crop.width,
                "height": crop.height,
            },
            "output_size": list(out_size),
            "output_scale": list(core.output_scale(crop, out_size)),
            "premultiply_alpha": premul,
            "filters": {},
            "pixels": {},
            "pixels_by_name": {},
            "sweeps": {},
        }

        if self.check_png.isChecked():
            os.makedirs(os.path.join(directory, "images"), exist_ok=True)
            core.save_png(
                os.path.join(directory, "images", "source.png"),
                samples.nearest_zoom(
                    samples.checkerboard_backdrop(image), max(1, zoom // 8)
                ),
            )
            for key, result in results.items():
                core.save_png(os.path.join(directory, "images", f"{key}.png"), result.rgba)
                core.save_png(
                    os.path.join(directory, "images", f"{key}_view.png"),
                    samples.nearest_zoom(
                        samples.checkerboard_backdrop(result.rgba), zoom
                    ),
                )

        for key, result in results.items():
            manifest["filters"][key] = {
                "name": result.filter_name,
                "metrics": result.metrics.as_dict(),
            }
        for x, y in pixels:
            named = {"x": x, "y": y, "exported_srgb": {}, "intermediate": {}}
            for key, result in results.items():
                named["exported_srgb"][key] = [int(v) for v in result.u8[y, x]]
                named["intermediate"][key] = [
                    round(float(v), 6) for v in result.rgba[y, x]
                ]
            manifest["pixels_by_name"][f"{x},{y}"] = named
        if self.check_json.isChecked():
            for key, result in results.items():
                entries = []
                for x, y in pixels:
                    rgba = [int(v) for v in result.u8[y, x]]
                    entries.append({"x": x, "y": y, "rgba": rgba})
                manifest["pixels"][key] = entries

        if self.check_sweep.isChecked():
            manifest["sweeps"] = self._write_sweep_csv(directory)

        if self.check_json.isChecked():
            with open(os.path.join(directory, "summary.json"), "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2, ensure_ascii=False, allow_nan=True)

        self.path_edit.setText(directory)
        self.accept()

    def _write_sweep_csv(self, directory: str) -> dict:
        crop_size = (self.tab.crop_size.value(), self.tab.crop_size.value())
        scale = self.tab.scale.value()
        steps = self.tab.sweep_steps.value()
        premul = self.tab.premultiply.isChecked()
        image = self.tab.current_image()
        info: dict[str, int] = {}

        scales = np.linspace(max(scale * 0.25, 0.0005), min(scale * 4.0, 4.0), steps)
        data = core.sweep_scales(image, crop_size, scales, premul)
        self._csv(os.path.join(directory, "sweep_scale.csv"), "scale", data)
        info["scale_rows"] = len(scales)

        offsets = np.linspace(-2.0, 2.0, steps)
        data = core.sweep_offsets(image, crop_size, offsets, "x", scale, premul)
        self._csv(os.path.join(directory, "sweep_offset_x.csv"), "dx", data)
        data = core.sweep_offsets(image, crop_size, offsets, "y", scale, premul)
        self._csv(os.path.join(directory, "sweep_offset_y.csv"), "dy", data)
        info["offset_rows"] = len(offsets)
        return info

    @staticmethod
    def _csv(path: str, x_name: str, data: dict[str, list[core.SweepPoint]]) -> None:
        fields = [
            "mean_alpha",
            "colour_luma",
            "edge_delta",
            "fringe_delta",
            "composite_luma",
        ]
        with open(path, "w", encoding="utf-8") as fh:
            header = ["filter", x_name, "out_w", "out_h"] + fields
            fh.write(",".join(header) + "\n")
            for key, points in data.items():
                for point in points:
                    row = [key, f"{point.x:.6f}", str(point.size[0]), str(point.size[1])]
                    row += [f"{getattr(point.metrics, f):.6f}" for f in fields]
                    fh.write(",".join(row) + "\n")
