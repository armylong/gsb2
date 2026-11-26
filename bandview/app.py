"""主窗口: 状态管理、渲染管线与视图联动。

视图集合 (共享同一 SyncGroup, 图像坐标完全一致):
  composite          三通道合成
  band:<name>        每个已加载波段一张灰度视图
  ndvi               归一化差值视图 (a/b 都选好时出现)

显示范围状态按波段名保存 (manual_ranges), 因此通道替换或参考区改变后,
其它视图与手动范围都保留; 只有点「重取自动范围」才覆盖。
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np
from PySide6.QtCore import QPointF, QTimer, Qt
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QDockWidget,
    QFileDialog,
    QGridLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from .canvas import ImageCanvas, SyncGroup
from .constants import DEFAULT_DENOM_EPS
from .generate import generate_sample_dataset
from .io_utils import (
    load_band,
    load_settings_json,
    save_rgba_png,
    save_settings_json,
)
from .model import BandData, clip_counts
from .rendering import render_composite, render_grayscale, render_ndvi
from .widgets import (
    BandPanel,
    ChannelPanel,
    ExportPanel,
    NdviPanel,
    RoiPanel,
    StretchPanel,
)

VIEW_COMPOSITE = "composite"
VIEW_NDVI = "ndvi"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("bandview — 多波段同机位合成查看器")
        self.resize(1500, 950)

        # ---- 状态 ----
        self.bands: dict[str, BandData] = {}
        self.band_order: list[str] = []
        self.roi: Optional[tuple[int, int, int, int]] = None
        self.manual_ranges: dict[str, tuple[float, float]] = {}
        self.assignment: tuple[object, object, object] = (None, None, None)
        self.show_clip = True
        self.ndvi_a: object = None
        self.ndvi_b: object = None
        self.ndvi_eps: float = DEFAULT_DENOM_EPS
        self._ndvi_cache: Optional[dict] = None

        # ---- 视图 ----
        self.sync_group = SyncGroup()
        self.canvases: dict[str, ImageCanvas] = {}
        self.view_host = QWidget()
        self.grid = QGridLayout(self.view_host)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.view_host)
        self.setCentralWidget(scroll)

        # ---- 控制面板 ----
        self.band_panel = BandPanel()
        self.channel_panel = ChannelPanel()
        self.stretch_panel = StretchPanel()
        self.roi_panel = RoiPanel()
        self.ndvi_panel = NdviPanel()
        self.export_panel = ExportPanel()

        side = QWidget()
        side_layout = QVBoxLayout(side)
        for panel in (
            self.band_panel,
            self.channel_panel,
            self.stretch_panel,
            self.roi_panel,
            self.ndvi_panel,
            self.export_panel,
        ):
            side_layout.addWidget(panel)
        side_layout.addStretch(1)
        side_scroll = QScrollArea()
        side_scroll.setWidgetResizable(True)
        side_scroll.setWidget(side)
        side_scroll.setMinimumWidth(380)
        side_scroll.setMaximumWidth(460)
        dock = QDockWidget("控制", self)
        dock.setWidget(side_scroll)
        self.addDockWidget(Qt.DockWidgetArea.LeftDockWidgetArea, dock)

        # 像素读数 dock
        self.info_label = QLabel("把鼠标移到图像上读取原始数值")
        self.info_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.info_label.setMinimumWidth(360)
        info_dock = QDockWidget("像素读数 (原像素坐标)", self)
        info_dock.setWidget(self.info_label)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, info_dock)

        self.statusBar().showMessage("就绪")

        toolbar = self.addToolBar("视图")
        fit_action = toolbar.addAction("适应窗口 (F)")
        fit_action.setShortcut("F")
        fit_action.triggered.connect(self.fit_all)
        toolbar.addSeparator()
        self.roi_action = toolbar.addAction("框选参考区 (R)")
        self.roi_action.setCheckable(True)
        self.roi_action.setShortcut("R")
        self.roi_action.toggled.connect(self.action_toggle_roi_mode)

        # ---- 信号 ----
        self.band_panel.load_requested.connect(self.action_load_bands)
        self.band_panel.remove_requested.connect(self.action_remove_band)
        self.channel_panel.assignment_changed.connect(self.on_assignment)
        self.stretch_panel.mode_changed.connect(lambda *_: self.schedule_refresh())
        self.stretch_panel.range_edited.connect(self.on_range_edited)
        self.stretch_panel.apply_auto.connect(self.action_apply_auto)
        self.stretch_panel.clip_toggle.connect(self.on_clip_toggle)
        self.roi_panel.draw_btn.clicked.connect(self.action_toggle_roi_mode)
        self.roi_panel.clear_btn.clicked.connect(self.action_clear_roi)
        self.ndvi_panel.params_changed.connect(self.on_ndvi_params)
        self.ndvi_panel.swap_requested.connect(lambda: self.statusBar().showMessage("已交换 a/b", 3000))
        self.export_panel.generate_sample.connect(self.action_generate)
        self.export_panel.export_composite.connect(self.action_export_composite)
        self.export_panel.export_settings.connect(self.action_export_settings)
        self.export_panel.import_settings.connect(self.action_import_settings)

        # 防抖: 连续操作合并为一次重渲染
        self.refresh_timer = QTimer(self)
        self.refresh_timer.setSingleShot(True)
        self.refresh_timer.setInterval(40)
        self.refresh_timer.timeout.connect(self.refresh_views)

        self._roi_mode = False
        self._last_cursor: Optional[QPointF] = None

    def fit_all(self) -> None:
        """所有视图重新适应窗口, 并广播统一 transform。"""
        first = next(iter(self.canvases.values()), None)
        if first is None:
            return
        first.fit_to_view()  # 内部已广播

    # ================= 波段加载 =================
    def action_load_bands(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "选择单通道图片或 .npy/.npz",
            "",
            "图像/数组 (*.png *.tif *.tiff *.bmp *.npy *.npz);;所有文件 (*)",
        )
        if not paths:
            return
        nodata_text = self._ask_nodata()
        try:
            nodata = float(nodata_text) if nodata_text.strip() else None
        except ValueError:
            nodata = None
        new_bands: list[BandData] = []
        for path in paths:
            try:
                band = load_band(path, nodata=nodata)
            except Exception as exc:  # 单张失败不影响其余
                QMessageBox.warning(self, "加载失败", f"{os.path.basename(path)}: {exc}")
                continue
            if self.bands and band.shape != next(iter(self.bands.values())).shape:
                QMessageBox.warning(
                    self,
                    "尺寸不一致",
                    f"{band.name} 尺寸 {band.shape} 与已有图像不符, 已跳过",
                )
                continue
            new_bands.append(band)
        if not new_bands:
            return
        for band in new_bands:
            self._register_band(band)
        self._after_bands_changed()

    def _ask_nodata(self) -> str:
        from PySide6.QtWidgets import QInputDialog

        text, ok = QInputDialog.getText(
            self, "无值像素", "无值标记的数值 (留空: 整数图无无值, 浮点图自动排除 NaN/Inf):", text="0"
        )
        return text if ok else ""

    def _register_band(self, band: BandData) -> None:
        name = band.name
        stem = name
        k = 2
        while name in self.bands:
            name = f"{stem}_{k}"
            k += 1
        band.name = name
        self.bands[name] = band
        self.band_order.append(name)
        stats = band.stats_in(None)
        self.manual_ranges[name] = (stats.minimum, stats.maximum)

    def _after_bands_changed(self) -> None:
        names = list(self.band_order)
        self.band_panel.set_bands([self.bands[n] for n in names])
        self.channel_panel.set_band_names(names)
        self.ndvi_panel.set_band_names(names)
        self._rebuild_canvases()
        self.schedule_refresh()

    def action_remove_band(self, index: int) -> None:
        name = self.band_order.pop(index)
        self.bands.pop(name)
        self.manual_ranges.pop(name, None)
        names = list(self.band_order)
        self.band_panel.set_bands([self.bands[n] for n in names])
        self.channel_panel.set_band_names(names)
        self.ndvi_panel.set_band_names(names)
        self._rebuild_canvases()
        self.schedule_refresh()

    # ================= 视图构建 =================
    def _rebuild_canvases(self) -> None:
        wanted = [VIEW_COMPOSITE] + [f"band:{n}" for n in self.band_order]
        if self.ndvi_a and self.ndvi_b and self.ndvi_a in self.bands and self.ndvi_b in self.bands:
            wanted.append(VIEW_NDVI)

        for key in list(self.canvases):
            if key not in wanted:
                canvas = self.canvases.pop(key)
                self.sync_group.remove(canvas)
                self.grid.removeWidget(canvas)
                canvas.deleteLater()
        for key in wanted:
            if key in self.canvases:
                continue
            title = self._canvas_title(key)
            canvas = ImageCanvas(title)
            canvas.set_mode("roi" if self._roi_mode else "nav")
            canvas.roi_changed.connect(self.on_canvas_roi)
            canvas.cursor_moved.connect(self.on_cursor)
            self.sync_group.add(canvas)
            self.canvases[key] = canvas
        self._layout_canvases()
        for canvas in self.canvases.values():
            canvas.set_roi(self.roi)

    def _layout_canvases(self) -> None:
        # 先全部取出 (快照计数, 避免边取边加导致死循环), 再按顺序重排
        for _ in range(self.grid.count()):
            self.grid.takeAt(0)
        cols = 3
        for i, key in enumerate(self.canvases):
            canvas = self.canvases[key]
            self.grid.addWidget(canvas, i // cols, i % cols)
            canvas.setMinimumSize(360, 300)

    def _canvas_title(self, key: str) -> str:
        if key == VIEW_COMPOSITE:
            return "合成视图"
        if key == VIEW_NDVI:
            return "归一化差值"
        return f"灰度: {key.split(':', 1)[1]}"

    # ================= 范围与拉伸 =================
    def on_assignment(self, assignment: tuple[object, object, object]) -> None:
        self.assignment = assignment
        self._rebuild_canvases()
        self.schedule_refresh()

    def on_clip_toggle(self, checked: bool) -> None:
        self.show_clip = checked
        self.schedule_refresh()

    def on_range_edited(self, key: str, lo: float, hi: float) -> None:
        if lo > hi:
            lo, hi = hi, lo
        if key == "common":
            for name in self.band_order:
                self.manual_ranges[name] = (lo, hi)
        else:
            idx = {"R": 0, "G": 1, "B": 2}[key]
            name = self.assignment[idx]
            if name:
                self.manual_ranges[name] = (lo, hi)
        self.schedule_refresh()

    def action_apply_auto(self) -> None:
        source_roi = self.roi if self.stretch_panel.source() == "roi" else None
        if source_roi is not None:
            x0, y0, x1, y1 = source_roi
            if x1 <= x0 or y1 <= y0:
                source_roi = None
        for name in self.band_order:
            stats = self.bands[name].stats_in(source_roi)
            if stats.count > 0:
                self.manual_ranges[name] = (stats.minimum, stats.maximum)
        self.schedule_refresh()
        self.statusBar().showMessage(
            f"已按{'参考区' if source_roi is not None else '全图'}重取范围", 3000
        )

    def _current_ranges(self) -> tuple[tuple[float, float], tuple[float, float], tuple[float, float]]:
        names = self.assignment
        ranges: list[tuple[float, float]] = []
        for name in names:
            if name and name in self.manual_ranges:
                ranges.append(self.manual_ranges[name])
            else:
                ranges.append((0.0, 1.0))
        if self.stretch_panel.stretch_mode() == "common":
            assigned = [self.manual_ranges[n] for n in names if n]
            if assigned:
                lo = min(r[0] for r in assigned)
                hi = max(r[1] for r in assigned)
                ranges = [(lo, hi)] * 3
        return tuple(ranges)  # type: ignore[return-value]

    # ================= 参考区 =================
    def action_toggle_roi_mode(self, checked: object = None) -> None:
        if isinstance(checked, bool):
            self._roi_mode = checked
        else:
            self._roi_mode = not self._roi_mode
        self.roi_action.blockSignals(True)
        self.roi_action.setChecked(self._roi_mode)
        self.roi_action.blockSignals(False)
        self.roi_panel.draw_btn.setText("退出框选模式" if self._roi_mode else "进入框选模式")
        for canvas in self.canvases.values():
            canvas.set_mode("roi" if self._roi_mode else "nav")

    def action_clear_roi(self) -> None:
        self.roi = None
        self.roi_panel.set_roi_text(None)
        for canvas in self.canvases.values():
            canvas.set_roi(None)
        self.schedule_refresh()

    def on_canvas_roi(self, _name: str, rect: object) -> None:
        if rect is None:
            return
        self.roi = rect
        self.roi_panel.set_roi_text(rect)
        for canvas in self.canvases.values():
            canvas.set_roi(rect)
        self.schedule_refresh()

    # ================= 归一化差值 =================
    def on_ndvi_params(self, a: object, b: object, eps: float) -> None:
        self.ndvi_a, self.ndvi_b, self.ndvi_eps = a, b, eps
        self._ndvi_cache = None
        self._rebuild_canvases()
        self.schedule_refresh()

    # ================= 刷新管线 =================
    def schedule_refresh(self) -> None:
        self.refresh_timer.start()

    def refresh_views(self) -> None:
        if not self.bands:
            for canvas in self.canvases.values():
                canvas.set_pixmap(QPixmap())
            self._sync_spins()
            self._update_stats_status()
            return

        # 灰度视图
        for name in self.band_order:
            key = f"band:{name}"
            canvas = self.canvases.get(key)
            if canvas is None:
                continue
            lo, hi = self.manual_ranges[name]
            rgba = render_grayscale(self.bands[name], lo, hi, self.show_clip)
            canvas.set_pixmap(self._to_pixmap(rgba))

        # 合成视图
        comp = self.canvases.get(VIEW_COMPOSITE)
        if comp is not None:
            band_tuple = tuple(self.bands.get(n) if n else None for n in self.assignment)
            if any(b is not None for b in band_tuple):
                rgba = render_composite(band_tuple, self._current_ranges(), self.show_clip)
                comp.set_pixmap(self._to_pixmap(rgba))

        # NDVI 视图
        ndvi_canvas = self.canvases.get(VIEW_NDVI)
        if ndvi_canvas is not None and self.ndvi_a and self.ndvi_b:
            rgba, ndvi, valid, low_denom = render_ndvi(
                self.bands[self.ndvi_a],
                self.bands[self.ndvi_b],
                self.ndvi_eps,
                self.show_clip,
            )
            ndvi_canvas.set_pixmap(self._to_pixmap(rgba))
            self._ndvi_cache = {"ndvi": ndvi, "valid": valid, "low_denom": low_denom}

        self._sync_spins()
        self._update_stats_status()
        if self._last_cursor is not None:
            self._render_info(self._last_cursor)

    def _sync_spins(self) -> None:
        values: dict[str, tuple[float, float]] = {}
        assigned = [n for n in self.assignment if n]
        if assigned:
            los = [self.manual_ranges[n][0] for n in assigned]
            his = [self.manual_ranges[n][1] for n in assigned]
            values["common"] = (min(los), max(his))
        else:
            values["common"] = (0.0, 1.0)
        for ch, idx in (("R", 0), ("G", 1), ("B", 2)):
            name = self.assignment[idx]
            values[ch] = self.manual_ranges[name] if name else (0.0, 1.0)
        self.stretch_panel.set_spin_values(values)

    def _update_stats_status(self) -> None:
        if not self.bands:
            self.statusBar().showMessage("就绪")
            return
        parts = []
        for name in self.band_order:
            lo, hi = self.manual_ranges[name]
            low_n, high_n = clip_counts(self.bands[name], lo, hi, self.roi)
            total = self.bands[name].stats_in(self.roi).count
            if total:
                parts.append(
                    f"{name}: 裁剪 {low_n + high_n}/{total} "
                    f"({100.0 * (low_n + high_n) / total:.1f}%)"
                )
        self.statusBar().showMessage("　".join(parts))

    @staticmethod
    def _to_pixmap(rgba: np.ndarray) -> QPixmap:
        h, w = rgba.shape[:2]
        image = QImage(
            rgba.tobytes(), w, h, 4 * w, QImage.Format.Format_RGBA8888
        ).copy()
        return QPixmap.fromImage(image)

    # ================= 像素读数 =================
    def on_cursor(self, _canvas_name: str, pos: object) -> None:
        self._last_cursor = pos
        self._render_info(pos)

    def _render_info(self, pos: object) -> None:
        if pos is None or not self.bands:
            self.info_label.setText("把鼠标移到图像上读取原始数值")
            return
        x = int(np.floor(pos.x()))
        y = int(np.floor(pos.y()))
        sample = next(iter(self.bands.values()))
        if not (0 <= x < sample.shape[1] and 0 <= y < sample.shape[0]):
            self.info_label.setText("(图像外)")
            return
        lines = [f"<b>坐标 x={x}, y={y}</b>"]
        for name in self.band_order:
            band = self.bands[name]
            if not band.valid[y, x]:
                lines.append(f"{name}: <span style='color:#c0c'>无值</span>")
                continue
            raw = band.data[y, x]
            lo, hi = self.manual_ranges[name]
            v = float(raw)
            if hi > lo:
                mapped = int(np.rint(np.clip((v - lo) / (hi - lo) * 255.0, 0, 255)))
            else:
                mapped = 128
            tag = ""
            if v < lo:
                tag = " <span style='color:#08c'>↓低于下界</span>"
            elif v > hi:
                tag = " <span style='color:#c33'>↑高于上界</span>"
            lines.append(f"{name}: 原始 <b>{raw}</b> ({band.dtype}) → 显示 {mapped}{tag}")
        if self._ndvi_cache is not None and self.ndvi_a and self.ndvi_b:
            ndvi = self._ndvi_cache["ndvi"]
            valid = self._ndvi_cache["valid"]
            low_denom = self._ndvi_cache["low_denom"]
            if not valid[y, x]:
                lines.append("归一化差值: 无值")
            elif low_denom[y, x]:
                lines.append("归一化差值: <span style='color:#33c'>分母过小</span>")
            else:
                lines.append(
                    f"({self.ndvi_a}−{self.ndvi_b})/({self.ndvi_a}+{self.ndvi_b}) = "
                    f"<b>{ndvi[y, x]:.6f}</b>"
                )
        self.info_label.setText("<br>".join(lines))

    # ================= 自带数据 / 导出导入 =================
    def action_generate(self) -> None:
        outdir = QFileDialog.getExistingDirectory(self, "选择测试图输出目录")
        if not outdir:
            return
        target = os.path.join(outdir, "bandview_sample")
        try:
            meta = generate_sample_dataset(target)
        except Exception as exc:
            QMessageBox.critical(self, "生成失败", str(exc))
            return
        # 直接加载 npy, nodata=0
        for name in meta["band_names"]:
            band = load_band(
                os.path.join(target, f"{name}.npy"),
                nodata=float(meta["nodata_value"]),
            )
            self._register_band(band)
        self._after_bands_changed()
        self.statusBar().showMessage(f"测试图已生成并加载: {target}", 8000)

    def action_export_composite(self) -> None:
        comp = self.canvases.get(VIEW_COMPOSITE)
        if comp is None or not self.assignment or not any(self.assignment):
            QMessageBox.information(self, "提示", "请先给至少一个屏幕通道分配波段")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出合成图", "composite.png", "PNG (*.png)")
        if not path:
            return
        band_tuple = tuple(self.bands.get(n) if n else None for n in self.assignment)
        rgba = render_composite(band_tuple, self._current_ranges(), self.show_clip)
        save_rgba_png(path, rgba)
        self.statusBar().showMessage(f"合成图已导出: {path}", 5000)

    def _settings_dict(self) -> dict:
        return {
            "version": 1,
            "bands": [
                {"name": n, "path": self.bands[n].source_path, "nodata": self.bands[n].nodata_value}
                for n in self.band_order
            ],
            "assignment": list(self.assignment),
            "manual_ranges": {k: list(v) for k, v in self.manual_ranges.items()},
            "roi": list(self.roi) if self.roi else None,
            "range_source": self.stretch_panel.source(),
            "stretch_mode": self.stretch_panel.stretch_mode(),
            "show_clip": self.show_clip,
            "ndvi": {"a": self.ndvi_a, "b": self.ndvi_b, "eps": self.ndvi_eps},
        }

    def action_export_settings(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "导出设置", "bandview_settings.json", "JSON (*.json)")
        if not path:
            return
        save_settings_json(path, self._settings_dict())
        self.statusBar().showMessage(f"设置已导出: {path}", 5000)

    def action_import_settings(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "导入设置", "", "JSON (*.json)")
        if not path:
            return
        try:
            settings = load_settings_json(path)
            self._apply_settings(settings)
        except Exception as exc:
            QMessageBox.critical(self, "导入失败", str(exc))

    def _apply_settings(self, settings: dict) -> None:
        # 重新加载波段 (路径仍存在时)
        reload_items = [
            (item["path"], item.get("nodata"), item["name"])
            for item in settings.get("bands", [])
            if item.get("path") and os.path.exists(item["path"])
        ]
        if reload_items:
            self.bands.clear()
            self.band_order.clear()
            self.manual_ranges.clear()
            for path, nodata, name in reload_items:
                band = load_band(path, name=name, nodata=nodata)
                self._register_band(band)
            self._after_bands_changed()

        saved_ranges = settings.get("manual_ranges", {})
        for name, pair in saved_ranges.items():
            if name in self.bands:
                self.manual_ranges[name] = (float(pair[0]), float(pair[1]))

        assignment = tuple(settings.get("assignment", [None, None, None]))
        self.channel_panel.set_band_names(self.band_order)
        for combo, name in zip(self.channel_panel.combos(), assignment):
            idx = combo.findData(name)
            if idx >= 0:
                combo.setCurrentIndex(idx)

        if settings.get("roi"):
            r = settings["roi"]
            self.on_canvas_roi(None, tuple(int(v) for v in r))
        if settings.get("show_clip") is not None:
            self.stretch_panel.cb_clip.setChecked(bool(settings["show_clip"]))
        ndvi = settings.get("ndvi", {})
        if ndvi:
            a, b = ndvi.get("a"), ndvi.get("b")
            if a in self.bands and b in self.bands:
                self.ndvi_panel.combo_a.setCurrentIndex(self.ndvi_panel.combo_a.findData(a))
                self.ndvi_panel.combo_b.setCurrentIndex(self.ndvi_panel.combo_b.findData(b))
                if ndvi.get("eps"):
                    self.ndvi_panel.eps_spin.setValue(float(ndvi["eps"]))
        self.schedule_refresh()
