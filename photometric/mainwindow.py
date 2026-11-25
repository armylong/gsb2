"""Main window: orchestrates scenes, solving, views and the shared context."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (QApplication, QHBoxLayout, QLabel, QMainWindow,
                               QMessageBox, QPushButton, QScrollArea, QTabWidget,
                               QVBoxLayout, QWidget)

from . import theme
from .context import AppContext
from .rig import LightSpec, assess
from .service import SolveService
from .solver import REASON_NAMES, SolveResult
from .synthesis import Scene, build_builtin, resize_stack, scene_from_images
from .views.coverage import CoverageView
from .views.export import ExportView
from .views.inputs import InputsView
from .views.normals import NormalsView
from .views.relight import RelightView
from .views.source import SourceView, load_grayscale
from .widgets.lightlist import LightList

APP_SUBTITLE = "同视角多灯灰度照片 → 表面朝向 · 全部本地计算"


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("光度立体 · 表面朝向工作台")
        self.resize(1480, 920)
        self.setMinimumSize(1180, 760)

        self.ctx = AppContext(self)
        self.service = SolveService(self)
        self._files: list[tuple[str, np.ndarray]] = []
        self._notice = ""

        self._build_ui()
        self._connect()

        self._load_scene("sphere", autorun=True)

    # ------------------------------------------------------------------- ui
    def _build_ui(self) -> None:
        central = QWidget()
        root = QHBoxLayout(central)
        root.setContentsMargins(12, 10, 12, 10)
        root.setSpacing(12)

        # ---------------------------------------------------------- sidebar
        sidebar = QWidget()
        sidebar.setFixedWidth(372)
        side = QVBoxLayout(sidebar)
        side.setContentsMargins(0, 0, 0, 0)
        side.setSpacing(8)

        header = QHBoxLayout()
        title = QLabel("光度立体")
        title.setObjectName("Title")
        header.addWidget(title)
        subtitle = QLabel(APP_SUBTITLE)
        subtitle.setObjectName("Subtitle")
        header.addWidget(subtitle, 1)
        side.addLayout(header)

        rig_box = QWidget()
        rig_box.setObjectName("Card")
        rig_box.setStyleSheet(
            f"QWidget#Card {{ background:{theme.PANEL}; border:1px solid {theme.BORDER}; "
            f"border-radius:8px; }}")
        rig_lay = QVBoxLayout(rig_box)
        rig_lay.setContentsMargins(10, 8, 10, 8)
        rig_lay.setSpacing(6)
        rig_head = QHBoxLayout()
        rig_title = QLabel("光照方向")
        rig_title.setStyleSheet("font-weight:700;")
        rig_head.addWidget(rig_title)
        rig_head.addStretch(1)
        self.add_light_btn = QPushButton("＋ 载入图片")
        self.add_light_btn.setFixedHeight(26)
        self.add_light_btn.clicked.connect(self._add_light)
        rig_head.addWidget(self.add_light_btn)
        rig_lay.addLayout(rig_head)

        self.verdict = QLabel("—")
        self.verdict.setWordWrap(True)
        self.verdict.setStyleSheet("font-weight:700; font-size:12px;")
        rig_lay.addWidget(self.verdict)
        self.verdict_detail = QLabel("")
        self.verdict_detail.setWordWrap(True)
        self.verdict_detail.setObjectName("Muted")
        self.verdict_detail.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        rig_lay.addWidget(self.verdict_detail)
        side.addWidget(rig_box)

        self.light_scroll = QScrollArea()
        self.light_scroll.setWidgetResizable(True)
        self.light_list = LightList()
        self.light_scroll.setWidget(self.light_list)
        side.addWidget(self.light_scroll, 1)

        buttons = QHBoxLayout()
        buttons.setSpacing(6)
        self.solve_btn = QPushButton("重新估计")
        self.solve_btn.setObjectName("Primary")
        self.solve_btn.setMinimumHeight(34)
        self.solve_btn.clicked.connect(self.solve)
        buttons.addWidget(self.solve_btn, 1)
        self.scene_btn = QPushButton("切换场景")
        self.scene_btn.setMinimumHeight(34)
        self.scene_btn.clicked.connect(lambda: self.tabs.setCurrentIndex(0))
        buttons.addWidget(self.scene_btn)
        side.addLayout(buttons)

        self.status = QLabel("")
        self.status.setObjectName("Muted")
        self.status.setWordWrap(True)
        self.status.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        side.addWidget(self.status)

        root.addWidget(sidebar)

        # ------------------------------------------------------------ tabs
        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.source_view = SourceView(self.ctx)
        self.inputs_view = InputsView(self.ctx)
        self.normals_view = NormalsView(self.ctx)
        self.coverage_view = CoverageView(self.ctx)
        self.relight_view = RelightView(self.ctx)
        self.export_view = ExportView(self.ctx)
        self.tabs.addTab(self.source_view, "场景与光照")
        self.tabs.addTab(self.inputs_view, "输入照片")
        self.tabs.addTab(self.normals_view, "表面朝向")
        self.tabs.addTab(self.coverage_view, "估计不足")
        self.tabs.addTab(self.relight_view, "重新照明")
        self.tabs.addTab(self.export_view, "导出核对")
        self.tabs.currentChanged.connect(self._on_tab_changed)
        root.addWidget(self.tabs, 1)

        self.setCentralWidget(central)
        self._make_menu()

    def _make_menu(self) -> None:
        menu = self.menuBar()
        file_menu = menu.addMenu("文件(&F)")
        act_solve = QAction("重新估计", self)
        act_solve.setShortcut(QKeySequence("Ctrl+R"))
        act_solve.triggered.connect(self.solve)
        file_menu.addAction(act_solve)
        act_export = QAction("导出并回读…", self)
        act_export.setShortcut(QKeySequence("Ctrl+E"))
        act_export.triggered.connect(self._export_shortcut)
        file_menu.addAction(act_export)
        file_menu.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.setShortcut(QKeySequence.StandardKey.Quit)
        act_quit.triggered.connect(self.close)
        file_menu.addAction(act_quit)

    def _connect(self) -> None:
        self.source_view.sceneRequested.connect(lambda key: self._load_scene(key, autorun=True))
        self.source_view.filesLoaded.connect(self._load_files)
        self.source_view.solveRequested.connect(self.solve)
        self.light_list.changed.connect(self._on_rig_edited)
        self.light_list.selected.connect(self._on_light_selected)
        self.light_list.loadRequested.connect(self._replace_light_image)
        self.light_list.removeRequested.connect(self._remove_light)
        self.service.started.connect(self._on_solve_started)
        self.service.finished.connect(self._on_solve_finished)
        self.service.failed.connect(self._on_solve_failed)
        self.ctx.resultChanged.connect(self._refresh_status)
        self.ctx.pinnedChanged.connect(self._refresh_status)

    # ------------------------------------------------------------------ scene
    def _load_scene(self, key: str, autorun: bool = True) -> None:
        try:
            scene = build_builtin(key)
        except KeyError:
            return
        self._files = []
        self._apply_scene(scene)
        if autorun:
            self.solve()

    def _apply_scene(self, scene: Scene) -> None:
        self.ctx.set_scene(scene)
        self.light_list.set_rows(scene.lights, loadable=scene.source == "files",
                                 removable=scene.source == "files")
        self._refresh_thumbnails()
        self._refresh_rig_verdict()
        self._refresh_status()

    def _load_files(self, loaded: list[tuple[str, np.ndarray]]) -> None:
        if len(loaded) < 3:
            QMessageBox.warning(self, "图片不足",
                                "光度立体至少需要三张同视角、同尺寸的灰度图。")
            return
        shapes = {img.shape for _, img in loaded}
        if len(shapes) != 1:
            QMessageBox.warning(self, "尺寸不一致",
                                "这些图片尺寸不同。请使用同视角、同尺寸的照片。")
            return
        self._files = loaded
        specs = []
        for i, (name, _) in enumerate(loaded):
            az = (i * 360.0 / len(loaded)) % 360.0
            specs.append(LightSpec(az, 45.0, True, name))
        images = np.stack([img for _, img in loaded], axis=0).astype(np.float32)
        images, factor = resize_stack(images, self.ctx.options.max_working_size)
        if factor < 1.0:
            height, width = images.shape[1], images.shape[2]
            self._notice = f"输入尺寸较大，已按 {factor:.2f}× 降到 {width}×{height} 求解。"
        else:
            self._notice = ""
        scene = scene_from_images(images, np.stack([s.direction for s in specs]),
                                  [s.name for s in specs])
        scene.lights = specs
        scene.title = "载入的图片"
        self._apply_scene(scene)
        self.solve()

    def _refresh_thumbnails(self) -> None:
        scene = self.ctx.scene
        if scene is None:
            return
        from .rendering import gray_rgb
        for i in range(scene.n_lights):
            self.light_list.set_thumbnail(i, gray_rgb(scene.images[i]))

    # ------------------------------------------------------------------- rig
    def _on_rig_edited(self) -> None:
        specs = self.light_list.specs()
        if self.ctx.scene is not None:
            self.ctx.scene.lights = specs
        self._refresh_rig_verdict()
        self.source_view.refresh()

    def _on_light_selected(self, index: int) -> None:
        self.ctx.set_active_light(index)
        self.coverage_view.set_light(index)

    def _refresh_rig_verdict(self) -> None:
        specs = self.light_list.specs()
        quality = assess(specs)
        self.light_list.set_notes(quality.per_light_notes, quality.per_light_ok)
        if quality.well_posed and quality.covers_hemisphere:
            colour = theme.OK
        elif quality.well_posed:
            colour = theme.WARN
        else:
            colour = theme.INVALID_COLOR
        self.verdict.setText(quality.headline)
        self.verdict.setStyleSheet(f"font-weight:700; font-size:12px; color:{colour};")
        self.verdict_detail.setText(quality.detail)
        if self.ctx.scene is not None and len(specs) == self.ctx.scene.n_lights:
            self.ctx.scene.lights = specs
        self.inputs_view.refresh()

    def _add_light(self) -> None:
        paths, _ = __import__("PySide6.QtWidgets", fromlist=["QFileDialog"]).QFileDialog \
            .getOpenFileNames(self, "载入灰度图", str(Path.home()),
                              "图片 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp)")
        if not paths:
            return
        if self.ctx.scene is None or self.ctx.scene.source != "files":
            self._bootstrap_from_paths(paths)
            return
        self._append_paths(paths)

    def _bootstrap_from_paths(self, paths: list[str]) -> None:
        try:
            loaded = [(Path(p).stem, load_grayscale(p)) for p in paths]
        except OSError as exc:
            QMessageBox.warning(self, "无法载入", str(exc))
            return
        self._load_files(loaded)

    def _append_paths(self, paths: list[str]) -> None:
        from .dialogs import DirectionDialog

        scene = self.ctx.scene
        assert scene is not None
        try:
            gray = load_grayscale(paths[0])
        except OSError as exc:
            QMessageBox.warning(self, "无法载入", str(exc))
            return
        if gray.shape != (scene.height, scene.width):
            QMessageBox.warning(self, "尺寸不一致",
                                f"新图片为 {gray.shape[1]}×{gray.shape[0]}，与当前场景不一致。")
            return
        dialog = DirectionDialog(f"为 {Path(paths[0]).name} 填写光方向", 180.0, 45.0, self)
        if dialog.exec() != dialog.DialogCode.Accepted:
            return
        direction = dialog.direction()
        from . import vecmath
        az, el = vecmath.az_el_from_direction(direction)
        specs = self.light_list.specs() + [LightSpec(az, el, True, Path(paths[0]).stem)]
        images = np.concatenate([scene.images, gray[None].astype(np.float32)], axis=0)
        scene = scene_from_images(images, np.stack([s.direction for s in specs]),
                                  [s.name for s in specs])
        scene.lights = specs
        self._apply_scene(scene)
        self.solve()

    def _replace_light_image(self, index: int) -> None:
        from PySide6.QtWidgets import QFileDialog
        from .dialogs import DirectionDialog

        scene = self.ctx.scene
        if scene is None:
            return
        path, _ = QFileDialog.getOpenFileName(self, "替换这一张灰度图", str(Path.home()),
                                              "图片 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp)")
        if not path:
            return
        try:
            gray = load_grayscale(path)
        except OSError as exc:
            QMessageBox.warning(self, "无法载入", str(exc))
            return
        if gray.shape != (scene.height, scene.width):
            QMessageBox.warning(self, "尺寸不一致", "新图片尺寸与场景不一致。")
            return
        spec = scene.lights[index]
        dialog = DirectionDialog(f"图 {index + 1} 的光方向", spec.azimuth_deg,
                                 spec.elevation_deg, self)
        if dialog.exec() != dialog.DialogCode.Accepted:
            return
        from . import vecmath
        az, el = vecmath.az_el_from_direction(dialog.direction())
        images = scene.images.copy()
        images[index] = gray
        scene.images = images
        scene.lights[index] = LightSpec(az, el, True, Path(path).stem)
        self.light_list.set_rows(scene.lights, loadable=True, removable=True)
        self._refresh_thumbnails()
        self._refresh_rig_verdict()
        self.solve()

    def _remove_light(self, index: int) -> None:
        scene = self.ctx.scene
        if scene is None or scene.source != "files" or scene.n_lights <= 3:
            QMessageBox.information(self, "不能移除",
                                    "至少需要三张照片才能继续估计。")
            return
        images = np.delete(scene.images, index, axis=0)
        specs = [s for i, s in enumerate(self.light_list.specs()) if i != index]
        scene = scene_from_images(images, np.stack([s.direction for s in specs]),
                                  [s.name for s in specs])
        scene.lights = specs
        self._apply_scene(scene)
        self.solve()

    # ------------------------------------------------------------------ solve
    def solve(self) -> None:
        scene = self.ctx.scene
        if scene is None:
            return
        specs = self.light_list.specs()
        scene.lights = specs
        active = [s for s in specs if s.enabled]
        if len(active) < 3:
            self.status.setText("至少需要三个启用的光照方向 —— 已保留上一次的估计。")
            return
        indices = [i for i, s in enumerate(specs) if s.enabled]
        images = scene.images[indices]
        directions = np.stack([s.direction for s in specs])[indices]
        if directions.shape[0] < 3:
            self.status.setText("至少需要三个启用的光照方向。")
            return
        self.service.request(images, directions, np.ones(images.shape[1:], bool),
                             self.ctx.options, np.asarray(indices, dtype=np.int32))

    def _on_solve_started(self) -> None:
        self.ctx.solving = True
        self.solve_btn.setEnabled(False)
        self.solve_btn.setText("估计中…")
        self.status.setText("正在求解…")

    def _on_solve_finished(self, result: SolveResult, seconds: float) -> None:
        self.ctx.solving = False
        self.solve_btn.setEnabled(True)
        self.solve_btn.setText("重新估计")
        self.ctx.last_solve_seconds = seconds
        self.ctx.set_result(result)
        self.normals_view._set_mode(self.normals_view.mode)
        self._refresh_status()

    def _on_solve_failed(self, message: str) -> None:
        self.ctx.solving = False
        self.solve_btn.setEnabled(True)
        self.solve_btn.setText("重新估计")
        self.status.setText(f"求解失败：{message}")
        QMessageBox.warning(self, "求解失败", message)

    # --------------------------------------------------------------- status
    def _refresh_status(self) -> None:
        result = self.ctx.result
        if result is None:
            return
        counts = result.counts_by_status()
        fraction = result.valid.sum() / max(1, int(result.object_mask.sum()))
        seconds = f"{self.ctx.last_solve_seconds:.2f}s" if self.ctx.last_solve_seconds else ""
        parts = [
            f"有效法线 {fraction * 100:.1f}%",
            f"阴影 {counts.get(2, 0):,}",
            f"饱和 {counts.get(1, 0):,}",
            f"非朗伯 {counts.get(3, 0):,}",
        ]
        text = " · ".join(parts) + (f"   ({seconds})" if seconds else "")
        if self._notice:
            text += "  " + self._notice
        self.status.setText(text)
        pin = self.ctx.pinned
        if pin is not None:
            info = self.ctx.probe_info()
            if info is not None:
                state = "可用" if info.valid else REASON_NAMES.get(info.reason, "无估计")
                self.ctx.message = f"({pin[0]}, {pin[1]}) {state}"

    # ------------------------------------------------------------- shortcuts
    def _export_shortcut(self) -> None:
        self.tabs.setCurrentWidget(self.export_view)
        self.export_view.export()

    def _on_tab_changed(self, index: int) -> None:
        widget = self.tabs.widget(index)
        if widget is self.normals_view:
            self.normals_view.refresh()
        elif widget is self.coverage_view:
            self.coverage_view.refresh()
        elif widget is self.relight_view:
            self.relight_view.refresh()
        elif widget is self.export_view:
            self.export_view.refresh()
        elif widget is self.inputs_view:
            self.inputs_view.refresh()

    def closeEvent(self, event):
        self.service.shutdown()
        super().closeEvent(event)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication(argv)
    app.setApplicationName("光度立体 · 表面朝向工作台")
    app.setOrganizationName("PhotometricStudio")
    theme.apply(app)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
