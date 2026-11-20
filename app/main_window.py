"""主窗口：内容感知横向缩窄工具的全部交互逻辑。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSlider,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from app.widgets import ImageView, ResultView
from app.worker import CarveThread
from content_aware import demos, io as ca_io
from content_aware.engine import carve_width, infeasible_reason


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地内容感知横向缩窄工具")
        self.resize(1280, 820)

        # ---- 核心状态 ----
        self.image: np.ndarray | None = None       # 原图 (H,W,3) BGR
        self.mask: np.ndarray | None = None        # 保护掩码，源图分辨率
        self.worker: CarveThread | None = None
        self.outcome = None                        # 最近一次“完成/停止”的结果
        self.dirty = False                         # 当前参数/笔迹是否与结果不一致
        self._marker_src = None                    # (x, y) 源图十字
        self._marker_res = None

        self._build_ui()

    # ================================================================== #
    # UI 构建
    # ================================================================== #
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        # ---- 顶部：导入 / 演示 ----
        top = QHBoxLayout()
        self.btn_open = QPushButton("导入图片…")
        self.btn_open.clicked.connect(self.open_image)
        self.btn_demo = QPushButton("载入演示图")
        self.btn_demo.clicked.connect(self.load_demo)
        self.btn_demo_block = QPushButton("载入全宽保护带样例")
        self.btn_demo_block.clicked.connect(self.load_blocked_demo)
        top.addWidget(self.btn_open)
        top.addWidget(self.btn_demo)
        top.addWidget(self.btn_demo_block)
        top.addStretch(1)
        root.addLayout(top)

        # ---- 控制条 ----
        ctrl = QHBoxLayout()
        ctrl.addWidget(QLabel("工具:"))
        self.combo_tool = QComboBox()
        self.combo_tool.addItems(["画保护区", "擦除保护区", "平移视图"])
        self.combo_tool.currentIndexChanged.connect(self._on_tool_changed)
        ctrl.addWidget(self.combo_tool)

        ctrl.addWidget(QLabel("笔刷:"))
        self.spin_brush = QSpinBox()
        self.spin_brush.setRange(2, 120)
        self.spin_brush.setValue(22)
        self.spin_brush.valueChanged.connect(self._on_brush_changed)
        ctrl.addWidget(self.spin_brush)

        self.btn_clear_mask = QPushButton("清空保护区")
        self.btn_clear_mask.clicked.connect(self.clear_mask)
        ctrl.addWidget(self.btn_clear_mask)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        ctrl.addWidget(sep)
        ctrl.addWidget(QLabel("目标宽度:"))
        self.slider_target = QSlider(Qt.Orientation.Horizontal)
        self.slider_target.setMinimumWidth(220)
        self.slider_target.valueChanged.connect(self._on_target_changed)
        ctrl.addWidget(self.slider_target, 1)
        self.spin_target = QSpinBox()
        self.spin_target.valueChanged.connect(self._spin_target_changed)
        ctrl.addWidget(self.spin_target)
        self.lbl_dims = QLabel("尚未导入图片")
        ctrl.addWidget(self.lbl_dims)
        root.addLayout(ctrl)

        # ---- 动作条 ----
        act = QHBoxLayout()
        self.btn_run = QPushButton("开始处理")
        self.btn_run.clicked.connect(self.start_process)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.clicked.connect(self.cancel_process)
        self.btn_cancel.setEnabled(False)
        self.btn_export = QPushButton("导出结果…")
        self.btn_export.clicked.connect(self.export_result)
        self.btn_export.setEnabled(False)
        self.btn_fit = QPushButton("视图复位")
        self.btn_fit.clicked.connect(self.fit_views)
        act.addWidget(self.btn_run)
        act.addWidget(self.btn_cancel)
        act.addWidget(self.btn_export)
        act.addWidget(self.btn_fit)
        act.addStretch(1)

        self.chk_seams = QCheckBox("预览实际删除路径")
        self.chk_seams.setChecked(True)
        self.chk_seams.toggled.connect(self._refresh_overlay)
        act.addWidget(self.chk_seams)

        act.addWidget(QLabel("前后分界:"))
        self.slider_split = QSlider(Qt.Orientation.Horizontal)
        self.slider_split.setRange(0, 100)
        self.slider_split.setValue(100)
        self.slider_split.setMaximumWidth(180)
        self.slider_split.valueChanged.connect(
            lambda v: self.result_view.set_split(v / 100.0)
        )
        act.addWidget(self.slider_split)
        root.addLayout(act)

        self.progress = QProgressBar()
        self.progress.setRange(0, 1)
        self.progress.setValue(0)
        root.addWidget(self.progress)

        # ---- 双视图 ----
        views = QHBoxLayout()
        self.source_view = ImageView()
        self.result_view = ResultView()
        self.source_view.imageClicked.connect(lambda x, y: self._set_marker(x, y))
        self.source_view.maskEdited.connect(self._on_mask_edited)
        self.result_view.resultPixelPicked.connect(self.pick_result_pixel)
        for v, title in ((self.source_view, "原图（在此绘制保护区域）"),
                         (self.result_view, "处理结果（点选像素溯源）")):
            box = QVBoxLayout()
            cap = QLabel(title)
            cap.setAlignment(Qt.AlignmentFlag.AlignCenter)
            box.addWidget(cap)
            box.addWidget(v, 1)
            views.addLayout(box, 1)
        root.addLayout(views, 1)

        # ---- 状态 + 日志 ----
        self.lbl_status = QLabel("请导入图片或载入演示图。")
        self.lbl_status.setWordWrap(True)
        self.lbl_status.setFrameStyle(QFrame.Shape.StyledPanel)
        root.addWidget(self.lbl_status)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(500)
        self.log.setFixedHeight(110)
        root.addWidget(self.log)

        self.setCentralWidget(central)
        self._set_running(False)

    # ================================================================== #
    # 导入与演示
    # ================================================================== #
    def open_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择不透明 PNG/JPEG", "",
            "图片 (*.png *.jpg *.jpeg)",
        )
        if not path:
            return
        try:
            image = ca_io.load_image(path)
        except ca_io.ImageLoadError as exc:
            QMessageBox.warning(self, "无法导入", str(exc))
            return
        self._load_image(image, source_name=Path(path).name)

    def load_demo(self) -> None:
        image, _ = demos.make_demo_scene()
        self._load_image(image, source_name="自生成演示图")
        self._log("已载入自生成演示图：纹理背景 + 房子/树/太阳主体 + 底部独立颜色标记。")

    def load_blocked_demo(self) -> None:
        image, _ = demos.make_demo_scene()
        self._load_image(image, source_name="全宽保护带样例")
        self.mask = demos.make_blocked_mask(*image.shape[:2])
        self.source_view.set_mask(self.mask)
        self._log("已载入不可行样例：一条贯穿全宽的横向保护带阻断所有接缝。")

    def _load_image(self, image: np.ndarray, source_name: str) -> None:
        self.image = image
        h, w = image.shape[:2]
        self.mask = np.zeros((h, w), dtype=bool)
        self.outcome = None
        self.dirty = False
        self._marker_src = self._marker_res = None

        # 目标宽度范围：原宽的 75% ~ 100%
        min_w = max(1, int(round(w * ca_io.TARGET_RATIO_MIN)))
        self.slider_target.blockSignals(True)
        self.spin_target.blockSignals(True)
        self.slider_target.setRange(min_w, w)
        self.spin_target.setRange(min_w, w)
        self.slider_target.setValue(w)
        self.spin_target.setValue(w)
        self.slider_target.blockSignals(False)
        self.spin_target.blockSignals(False)

        self.source_view.set_image(image, self.mask)
        self.result_view.set_image(image, self.mask)
        self.result_view.set_result(image)
        self.result_view.set_split(1.0)
        self.btn_export.setEnabled(False)
        self.progress.setRange(0, 1)
        self.progress.setValue(0)
        self._set_status(
            f"[{source_name}] 原图 {w}×{h}；目标宽度范围 {min_w}~{w}px（75%~100%），高度恒为 {h}px。"
        )
        self._log(f"载入 {source_name}，尺寸 {w}×{h}。")

    # ================================================================== #
    # 保护绘制
    # ================================================================== #
    def _on_tool_changed(self, idx: int) -> None:
        mode = {0: "protect", 1: "erase", 2: "none"}[idx]
        self.source_view.set_mode(mode)

    def _on_mask_edited(self) -> None:
        # 视图与主窗口共享同一个掩码数组，这里只负责标脏
        self._mark_dirty("保护区已修改。")

    def _on_brush_changed(self, value: int) -> None:
        self.source_view.set_brush_size(value)

    def clear_mask(self) -> None:
        if self.mask is None:
            return
        self.mask.fill(False)
        self.source_view.set_mask(self.mask)
        self._mark_dirty("已清空保护区。")

    def _refresh_overlay(self) -> None:
        if self.image is None:
            return
        if self.chk_seams.isChecked() and self.outcome is not None:
            self.source_view.set_removed_points(
                self.outcome.removed_source_points,
                self.outcome.height,
                self.outcome.source_width,
            )
        else:
            self.source_view.set_removed_points([], self.image.shape[0], self.image.shape[1])

    # ================================================================== #
    # 目标宽度
    # ================================================================== #
    def _on_target_changed(self, value: int) -> None:
        if self.spin_target.value() != value:
            self.spin_target.blockSignals(True)
            self.spin_target.setValue(value)
            self.spin_target.blockSignals(False)
        self._mark_dirty(f"目标宽度改为 {value}px。")

    def _spin_target_changed(self, value: int) -> None:
        if self.slider_target.value() != value:
            self.slider_target.blockSignals(True)
            self.slider_target.setValue(value)
            self.slider_target.blockSignals(False)
        self._mark_dirty(f"目标宽度改为 {value}px。")

    # ================================================================== #
    # 处理（后台线程，可取消）
    # ================================================================== #
    def start_process(self) -> None:
        if self.image is None or self.mask is None:
            QMessageBox.information(self, "提示", "请先导入图片。")
            return
        if self.worker is not None and self.worker.isRunning():
            return
        target = self.slider_target.value()
        h, w = self.image.shape[:2]

        # 目标等于原宽：零删除即完成，无需起后台线程
        if target == w:
            outcome = carve_width(self.image, self.mask.copy(), w)
            self._on_finished(outcome)
            return

        # 每次都以原图和当前保护掩码为起点，绝不在上一版成品上累计
        self.worker = CarveThread(self.image, self.mask.copy(), target, self)
        self.worker.progress.connect(self._on_progress)
        self.worker.status.connect(self._set_status)
        self.worker.finished_outcome.connect(self._on_finished)
        self.worker.finished.connect(self._on_thread_done)
        total = self.image.shape[1] - target
        self.progress.setRange(0, max(total, 1))
        self.progress.setValue(0)
        self._set_running(True)
        self._set_status(f"处理中：计划删除 {total} 列接缝，目标宽度 {target}px……")
        self.worker.start()

    def cancel_process(self) -> None:
        if self.worker is not None and self.worker.isRunning():
            self.worker.cancel()
            self.btn_cancel.setEnabled(False)

    def _on_progress(self, done: int, total: int) -> None:
        self.progress.setMaximum(max(total, 1))
        self.progress.setValue(done)
        self._set_status(f"处理中：已删除 {done}/{total} 条接缝……")

    def _on_finished(self, outcome) -> None:
        self.outcome = outcome
        self.dirty = False
        # 用真实结果刷新结果视图；源视图叠加删除路径
        self.result_view.set_image(self.image, self.mask)
        self.result_view.set_result(outcome.result)
        self.result_view.set_split(self.slider_split.value() / 100.0)
        self._refresh_overlay()
        self.progress.setValue(self.progress.maximum() if outcome.completed else len(outcome.removed_seams))
        # 取消得到的是半成品，禁止作为完成结果导出；不可行停止属合法结果可导出
        self.btn_export.setEnabled(not outcome.cancelled)

        reason = infeasible_reason(outcome)
        flags = []
        if outcome.cancelled:
            flags.append("【已取消·保留上次有效结果】")
        if outcome.stopped_infeasible:
            flags.append("【保护约束不可行·已停止】")
        if self.dirty:
            flags.append("【参数与结果不一致】")
        self._set_status(
            f"实际完成宽度 {outcome.width}px / 目标 {outcome.target_width}px；"
            f"剩余目标量 {outcome.remaining}px；已删接缝 {len(outcome.removed_seams)} 条、"
            f"像素 {len(outcome.removed_source_points)} 个。{' '.join(flags)} {reason}"
        )
        self._log(
            f"完成：{outcome.source_width}px -> {outcome.width}px（目标 {outcome.target_width}，"
            f"剩余 {outcome.remaining}，接缝 {len(outcome.removed_seams)}，"
            f"取消={outcome.cancelled}，不可行停止={outcome.stopped_infeasible}）"
        )

    def _on_thread_done(self) -> None:
        self._set_running(False)
        if self.worker is not None:
            self.worker.deleteLater()
            self.worker = None

    def _set_running(self, running: bool) -> None:
        for b in (self.btn_open, self.btn_demo, self.btn_demo_block,
                  self.btn_run, self.btn_clear_mask,
                  self.slider_target, self.spin_target):
            b.setEnabled(not running)
        self.btn_cancel.setEnabled(running)
        if not running:
            # 导出仅在有结果、参数未变且不是取消的半成品时可用
            self.btn_export.setEnabled(
                self.outcome is not None
                and not self.dirty
                and not self.outcome.cancelled
            )

    # ================================================================== #
    # 点选溯源
    # ================================================================== #
    def pick_result_pixel(self, rx: int, ry: int) -> None:
        if self.outcome is None or self.image is None:
            return
        h, w = self.outcome.result.shape[:2]
        if not (0 <= rx < w and 0 <= ry < h):
            return
        src_x = int(self.outcome.source_index[ry, rx])
        self._set_marker(src_x, ry, result_xy=(rx, ry))
        # 该源像素是否已被删除：结果里能点到的必然是保留像素
        self._log(
            f"溯源：结果像素 (x={rx}, y={ry}) <- 源图 (x={src_x}, y={ry})，"
            f"BGR={tuple(int(v) for v in self.outcome.result[ry, rx])}"
        )

    def _set_marker(self, x: int, y: int, result_xy=None) -> None:
        self._marker_src = (x, y)
        self.source_view.set_marker(x, y)
        if result_xy is not None:
            self.result_view.set_marker(result_xy[0], result_xy[1], result_side=True)
        else:
            self.result_view.set_marker(None)

    def fit_views(self) -> None:
        self.source_view.fit_view()
        self.result_view.fit_view()

    # ================================================================== #
    # 脏状态与导出
    # ================================================================== #
    def _mark_dirty(self, message: str = "") -> None:
        if self.image is None:
            return
        self.dirty = True
        self.btn_export.setEnabled(False)
        if self.outcome is not None:
            self._set_status(
                f"参数/保护区已变化，当前显示的结果（{self.outcome.width}px）与新参数不一致；"
                f"请重新处理。{message}"
            )
        elif message:
            self._set_status(message)
        if message:
            self._log(message)

    def export_result(self) -> None:
        if self.outcome is None:
            return
        if self.dirty:
            QMessageBox.warning(
                self, "无法导出",
                "当前参数或保护区与结果不一致，请先重新处理。",
            )
            return
        if self.outcome.cancelled:
            QMessageBox.warning(
                self, "无法导出",
                "上次处理被取消，保留的是停止前的半成品，不能作为完成结果导出。\n"
                "请重新处理到目标宽度，或接受当前停止尺寸后再导出。",
            )
            return
        base, _ = QFileDialog.getSaveFileName(
            self, "导出结果（将生成 png / _map.npz / _meta.json）",
            "carve_result", "结果文件 (*.png)",
        )
        if not base:
            return
        try:
            paths = ca_io.export_result(self.outcome, base)
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        self._log(
            f"已导出：{paths['png'].name}、{paths['map'].name}、{paths['meta'].name}"
        )
        self._set_status(
            f"已导出实际尺寸 {self.outcome.width}×{self.outcome.height} 的结果与像素对应记录。"
        )

    # ================================================================== #
    # 辅助
    # ================================================================== #
    def _set_status(self, text: str) -> None:
        self.lbl_status.setText(text)

    def _log(self, text: str) -> None:
        self.log.appendPlainText(text)

    def closeEvent(self, event) -> None:
        if self.worker is not None and self.worker.isRunning():
            self.worker.cancel()
            self.worker.wait(5000)
        event.accept()
