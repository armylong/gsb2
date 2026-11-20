"""主窗口：输入/灰度展示、A-B 对照、选区统计、导出与回读校验。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTextEdit,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from halftone.core import (
    DEFAULT_PARAMS,
    HalftoneError,
    black_fraction,
    selection_stats,
    to_grayscale,
)
from halftone.io import (
    ImageLoadError,
    export_result,
    load_image,
    verify_export,
)
from halftone.samples import SAMPLE_NAMES, build_sample

from .image_canvas import MODE_PIXEL, MODE_SMOOTH, ImageCanvas
from .param_panel import ParamPanel
from .render_worker import RenderService

_GROUPS = ("A", "B")


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("单色半色调预览（黑墨白纸）")
        self.resize(1380, 880)

        # 状态
        self.source_name = ""
        self.bgr: np.ndarray | None = None
        self.gray: np.ndarray | None = None
        self.params = {g: dict(DEFAULT_PARAMS) for g in _GROUPS}
        self.binary = {g: None for g in _GROUPS}
        self.selection_rect: tuple[int, int, int, int] | None = None
        self.view_mode = MODE_PIXEL
        # 记录上次已提交渲染的参数哈希，避免重复请求
        self._render_hash = {g: None for g in _GROUPS}

        self._build_toolbar()
        self._build_central()

        # 后台渲染线程
        self.render_service = RenderService(self)
        self.render_service.rendered.connect(self._on_rendered)
        self.render_service.failed.connect(self._on_render_failed)

        self._load_sample(next(iter(SAMPLE_NAMES)))

    # ============================================================== 界面搭建
    def _build_toolbar(self) -> None:
        bar = QToolBar("主工具栏", self)
        bar.setMovable(False)
        self.addToolBar(bar)

        open_btn = QAction("打开 PNG/JPEG", self)
        open_btn.triggered.connect(self._open_file)
        bar.addAction(open_btn)

        bar.addWidget(QLabel("  自带素材: "))
        self.sample_box = QComboBox()
        for key, label in SAMPLE_NAMES.items():
            self.sample_box.addItem(label, key)
        self.sample_box.currentIndexChanged.connect(
            lambda: self._load_sample(self.sample_box.currentData())
        )
        bar.addWidget(self.sample_box)
        bar.addSeparator()

        fit_btn = QAction("适应窗口", self)
        fit_btn.triggered.connect(self._fit_all)
        bar.addAction(fit_btn)
        actual_btn = QAction("100% 实际像素", self)
        actual_btn.triggered.connect(self._actual_all)
        bar.addAction(actual_btn)
        bar.addSeparator()

        self.mode_btn = QPushButton("切换到平滑预览")
        self.mode_btn.clicked.connect(self._toggle_mode)
        bar.addWidget(self.mode_btn)

        bar.addSeparator()
        clear_sel = QAction("清除选区", self)
        clear_sel.triggered.connect(lambda: self._set_selection(None))
        bar.addAction(clear_sel)
        bar.addSeparator()

        export_a = QAction("导出 A", self)
        export_a.triggered.connect(lambda: self._export("A"))
        bar.addAction(export_a)
        export_b = QAction("导出 B", self)
        export_b.triggered.connect(lambda: self._export("B"))
        bar.addAction(export_b)
        verify_btn = QAction("回读校验导出文件", self)
        verify_btn.triggered.connect(self._verify_existing)
        bar.addAction(verify_btn)

        self.statusBar().showMessage(
            "左键拖拽=框选统计；中键(或空格+左键)=平移；滚轮=缩放。网格固定在图像坐标，缩放不重排网点。"
        )

    def _build_central(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal, self)

        # ---- 左侧: 参数面板 + 统计 ----
        left = QWidget()
        left_layout = QVBoxLayout(left)
        self.group_tabs = QTabWidget()
        self.param_panels: dict[str, ParamPanel] = {}
        for g in _GROUPS:
            panel = ParamPanel(g)
            panel.paramsChanged.connect(self._on_params_changed)
            panel.resetRequested.connect(self._on_reset)
            self.param_panels[g] = panel
            self.group_tabs.addTab(panel, f"参数组 {g}")
        left_layout.addWidget(self.group_tabs)

        self.gray_label = QLabel()
        self.gray_label.setWordWrap(True)
        self.gray_label.setStyleSheet("color: #444; padding: 4px;")
        left_layout.addWidget(self.gray_label)

        left_layout.addWidget(QLabel("选区统计（实测值，非理论值）："))
        self.stats_box = QTabWidget()
        self.stats_text: dict[str, QTextEdit] = {}
        for g in _GROUPS:
            te = QTextEdit()
            te.setReadOnly(True)
            self.stats_text[g] = te
            self.stats_box.addTab(te, f"{g} 组统计")
        left_layout.addWidget(self.stats_box, stretch=1)

        # ---- 右侧: 三个页签的画布 ----
        self.tabs = QTabWidget()
        self.canvas_input = ImageCanvas("原图（BGR）")
        self.canvas_gray = ImageCanvas("灰度图 BT.601 Y=0.299R+0.587G+0.114B")
        self.canvas_a = ImageCanvas("A 组二值结果")
        self.canvas_b = ImageCanvas("B 组二值结果")
        self.all_canvases = [
            self.canvas_input,
            self.canvas_gray,
            self.canvas_a,
            self.canvas_b,
        ]

        input_tab = QWidget()
        lay = QHBoxLayout(input_tab)
        lay.addWidget(self.canvas_input)
        gray_tab = QWidget()
        lay = QHBoxLayout(gray_tab)
        lay.addWidget(self.canvas_gray)
        compare_tab = QWidget()
        lay = QHBoxLayout(compare_tab)
        lay.addWidget(self.canvas_a)
        lay.addWidget(self.canvas_b)

        self.tabs.addTab(input_tab, "原图")
        self.tabs.addTab(gray_tab, "灰度图")
        self.tabs.addTab(compare_tab, "A / B 同位置对照")
        self.tabs.currentChanged.connect(self._fit_all)

        for c in self.all_canvases:
            c.selectionChanged.connect(self._on_selection_from_canvas)
            c.viewChanged.connect(self._on_view_changed)
            c.cursorInfo.connect(self.statusBar().showMessage)

        splitter.addWidget(left)
        splitter.addWidget(self.tabs)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([360, 1020])
        self.setCentralWidget(splitter)

    # ============================================================== 输入
    def _open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开不透明 PNG/JPEG（最长边 ≤ 1200px）",
            "",
            "图像 (*.png *.jpg *.jpeg)",
        )
        if not path:
            return
        try:
            img = load_image(path)
        except ImageLoadError as exc:
            self._warn(str(exc))
            return
        self._set_image(img, os.path.basename(path))

    def _load_sample(self, key: str) -> None:
        if not key:
            return
        img = build_sample(key)
        self._set_image(img, f"自带素材：{SAMPLE_NAMES[key]}")

    def _set_image(self, bgr: np.ndarray, name: str) -> None:
        self.bgr = bgr
        self.gray = to_grayscale(bgr)
        self.source_name = name
        h, w = self.gray.shape
        self.gray_label.setText(
            f"来源：{name}\n尺寸：{w} × {h} px（最长边 {max(h, w)} ≤ 1200）\n"
            "灰度口径：ITU-R BT.601，Y=0.299R+0.587G+0.114B（定点四舍五入）\n"
            "网点输出：仅 0(黑墨)/255(白纸) 两值，中间灰只靠覆盖面积表达"
        )
        self.canvas_input.set_image(self.bgr)
        self.canvas_gray.set_image(self.gray)
        placeholder = np.full_like(self.gray, 255)
        self.canvas_a.set_image(placeholder)
        self.canvas_b.set_image(placeholder)
        self.binary = {g: None for g in _GROUPS}
        self._render_hash = {g: None for g in _GROUPS}
        self._set_selection(None)
        # 后台线程切换到新输入，旧队列作废
        self.render_service.reset(self.gray)
        self._refresh_all()
        self._fit_all()

    # ============================================================== 参数/渲染
    def _on_params_changed(self, group: str) -> None:
        panel = self.param_panels[group]
        try:
            values = panel.validated_values()
        except HalftoneError:
            self.stats_text[group].setPlainText(
                "参数非法，已暂停该组渲染，请修正后再看结果。"
            )
            return
        if values == self.params[group] and self.binary[group] is not None:
            return
        self.params[group] = values
        self._request_render(group)

    def _on_reset(self, group: str) -> None:
        self.params[group] = dict(DEFAULT_PARAMS)
        self.param_panels[group].set_values(DEFAULT_PARAMS)
        self._request_render(group)

    def _render_hash_for(self, group: str) -> int:
        p = self.params[group]
        return hash(
            (
                self.gray.tobytes(),
                p["screen"],
                round(p["period"], 6),
                round(p["angle"], 6),
                round(p["phase_x"], 6),
                round(p["phase_y"], 6),
                round(p["gamma"], 6),
            )
        )

    def _request_render(self, group: str) -> None:
        if self.gray is None:
            return
        h = self._render_hash_for(group)
        if h == self._render_hash[group] and self.binary[group] is not None:
            return
        self._render_hash[group] = h
        # 复制一份参数投递，避免后台读取时界面又在改同一字典
        self.render_service.request(group, dict(self.params[group]))
        self.stats_text[group].setPlainText("正在后台渲染…")

    def _on_rendered(self, group: str, binary: np.ndarray) -> None:
        self.binary[group] = binary
        canvas = self.canvas_a if group == "A" else self.canvas_b
        canvas.set_image(binary)
        canvas.set_mode(self.view_mode)
        if self.selection_rect is not None:
            canvas.set_selection(self.selection_rect)
        self._update_stats(group)

    def _on_render_failed(self, group: str, message: str) -> None:
        self.stats_text[group].setPlainText(f"渲染失败：{message}")

    def _refresh_all(self) -> None:
        for g in _GROUPS:
            # 面板值与状态对齐
            self.param_panels[g].set_values(self.params[g])
            self._request_render(g)

    # ============================================================== 视图
    def _toggle_mode(self) -> None:
        self.view_mode = (
            MODE_SMOOTH if self.view_mode == MODE_PIXEL else MODE_PIXEL
        )
        self.mode_btn.setText(
            "切换到平滑预览" if self.view_mode == MODE_PIXEL else "切换到逐像素二值"
        )
        for c in (self.canvas_a, self.canvas_b):
            c.set_mode(self.view_mode)

    def _fit_all(self) -> None:
        for c in self.all_canvases:
            c.fit_to_window()

    def _actual_all(self) -> None:
        for c in self.all_canvases:
            c.zoom_actual()

    def _on_view_changed(self, source: ImageCanvas) -> None:
        # 同尺寸画布同步平移与缩放；原图/灰度与二值图尺寸一致，全部可同步
        for c in self.all_canvases:
            if c is not source:
                c.sync_from(source)

    # ============================================================== 选区
    def _on_selection_from_canvas(self, rect) -> None:
        self._set_selection(rect, origin_sender=self.sender())

    def _set_selection(self, rect, origin_sender=None) -> None:
        self.selection_rect = rect
        for c in self.all_canvases:
            if c is not origin_sender:
                c.set_selection(rect)
        for g in _GROUPS:
            self._update_stats(g)

    def _update_stats(self, group: str) -> None:
        te = self.stats_text[group]
        if self.gray is None or self.binary[group] is None:
            te.setPlainText("暂无图像。")
            return
        p = self.params[group]
        if self.selection_rect is None:
            te.setPlainText(
                "未选择区域：请在任意画布上按住左键拖出选框。\n"
                f"（当前全图黑像素占比 {black_fraction(self.binary[group]):.4f}，"
                "仅供参考）"
            )
            return
        try:
            stats = selection_stats(
                self.gray, self.binary[group], p, self.selection_rect
            )
        except HalftoneError as exc:
            te.setPlainText(f"无法统计：{exc}")
            return
        diff = stats.measured_black_fraction - stats.target_ink_mean
        te.setPlainText(
            f"选区 (x={stats.x}, y={stats.y}, w={stats.w}, h={stats.h})\n"
            f"像素数：{stats.pixel_count}\n"
            f"输入平均灰度：{stats.input_gray_mean:.2f} / 255\n"
            f"目标墨量（曲线后）：{stats.target_ink_mean:.4f}\n"
            f"实测黑像素占比：{stats.measured_black_fraction:.4f}\n"
            f"实测 − 目标：{diff:+.4f}\n"
            "说明：边界截断与小选区存在量化误差，此处始终显示实测值。"
        )

    # ============================================================== 导出
    def _export(self, group: str) -> None:
        if self.gray is None or self.binary[group] is None:
            self._warn("还没有可导出的结果。")
            return
        default_name = (
            os.path.splitext(os.path.basename(self.source_name))[0]
            + f"_halftone_{group}.png"
        )
        path, _ = QFileDialog.getSaveFileName(
            self, f"导出 {group} 组二值 PNG", default_name, "PNG (*.png)"
        )
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"

        stats_payload = []
        if self.selection_rect is not None:
            try:
                stats_payload.append(
                    selection_stats(
                        self.gray,
                        self.binary[group],
                        self.params[group],
                        self.selection_rect,
                    ).as_dict()
                )
            except HalftoneError:
                stats_payload = []
        try:
            png_path, json_path = export_result(
                path,
                self.binary[group],
                self.params[group],
                source_name=self.source_name,
                stats=stats_payload,
            )
            check = verify_export(png_path, json_path)
        except (ImageLoadError, OSError, ValueError) as exc:
            self._warn(f"导出失败：{exc}")
            return
        QMessageBox.information(
            self,
            "导出完成并已回读",
            f"文件：{png_path}\n参数记录：{json_path}\n\n{check.summary()}",
        )

    def _verify_existing(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择要回读校验的二值 PNG", "", "PNG (*.png)"
        )
        if not path:
            return
        json_path = os.path.splitext(path)[0] + ".json"
        try:
            check = verify_export(
                path, json_path if os.path.isfile(json_path) else None
            )
        except (ImageLoadError, OSError, KeyError) as exc:
            self._warn(f"回读失败：{exc}")
            return
        box = QMessageBox.information if check.ok else QMessageBox.warning
        box(self, "回读校验", check.summary())

    # ============================================================== 杂项
    def _warn(self, text: str) -> None:
        QMessageBox.warning(self, "提示", text)

    def closeEvent(self, event) -> None:
        try:
            self.render_service.shutdown()
        except RuntimeError:
            pass
        event.accept()


def run() -> int:
    # 延迟导入，保证核心模块测试不依赖 QApplication
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()
