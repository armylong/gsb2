"""颜色校准主窗口：加载图片/色卡、取样、拟合、预览、导出。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import QSignalBlocker, Qt
from PySide6.QtGui import QAction, QPixmap
from PySide6.QtWidgets import (
    QFileDialog,
    QMainWindow,
    QMessageBox,
    QSplitter,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from .. import calibration as calib
from ..project import load_project, save_project
from ..reference import ReferenceError, load_reference
from ..sampleimage import build_sample_image
from ..sampling import ROIRect, sample_all
from ..srgb import clip_srgb, delta_e, srgb_array_to_lab
from .imageview import ImageView
from .panels import CalibrationPanel, PreviewPanel, SamplingPanel
from .qtimage import load_image, to_qimage, to_uint8


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地颜色校准（色卡对色）")
        self.resize(1400, 900)

        # ---- 状态 ----
        self.image_path: str = ""
        self.reference_path: str = ""
        self.image: np.ndarray | None = None          # 原始输入图，永不修改
        self.references: list = []
        self.ref_lookup: dict = {}
        self.samples: dict = {}
        self.model_full: calib.ColorModel | None = None
        self.model_wb: calib.ColorModel | None = None
        self.calib_error: str = ""
        self.corrected_full: np.ndarray | None = None  # 浮点 sRGB，可能越界
        self.corrected_wb: np.ndarray | None = None
        self.clip_mask_full: np.ndarray | None = None
        self.project_path: str = ""

        # ---- 布局 ----
        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.view = ImageView()
        right = QWidget()
        right_layout = QVBoxLayout(right)
        self.panel_sample = SamplingPanel()
        self.panel_calib = CalibrationPanel()
        self.panel_preview = PreviewPanel()
        right_layout.addWidget(self.panel_sample, stretch=3)
        right_layout.addWidget(self.panel_calib, stretch=3)
        right_layout.addWidget(self.panel_preview, stretch=1)
        splitter.addWidget(self.view)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        self.setCentralWidget(splitter)
        self.setStatusBar(QStatusBar())

        self._build_menus()
        self._wire_signals()

    # ================= 菜单 =================
    def _build_menus(self) -> None:
        bar = self.menuBar()
        m_file = bar.addMenu("文件")
        act_open_img = QAction("打开图片…", self)
        act_open_img.triggered.connect(self.choose_image)
        act_open_ref = QAction("打开参考色卡…", self)
        act_open_ref.triggered.connect(self.choose_reference)
        act_reload_ref = QAction("重新加载参考色卡（不改原图）", self)
        act_reload_ref.triggered.connect(self.reload_reference)
        act_open_proj = QAction("打开取样设置…", self)
        act_open_proj.triggered.connect(self.choose_project)
        act_save_proj = QAction("保存取样设置…", self)
        act_save_proj.triggered.connect(self.save_settings_as)
        m_file.addActions([act_open_img, act_open_ref, act_reload_ref])
        m_file.addSeparator()
        m_file.addActions([act_open_proj, act_save_proj])

        m_sample = bar.addMenu("样例")
        act_sample = QAction("载入内置偏色样例", self)
        act_sample.triggered.connect(self.load_builtin_sample)
        m_sample.addAction(act_sample)

        m_view = bar.addMenu("视图")
        act_fit = QAction("适合窗口", self)
        act_fit.triggered.connect(self.view.fit_to_window)
        m_view.addAction(act_fit)

    def _wire_signals(self) -> None:
        self.view.rois_changed.connect(self.on_rois_changed)
        self.view.selection_changed.connect(self.panel_sample.select_patch)
        self.panel_sample.patch_selected.connect(self.on_patch_selected)
        self.panel_sample.draw_requested.connect(self.view.set_draw_target)
        self.panel_sample.role_changed.connect(self.apply_role)
        self.panel_sample.enabled_changed.connect(self.apply_enabled)
        self.panel_sample.delete_requested.connect(self.view.remove_roi)
        self.panel_sample.sample_all_requested.connect(self.refresh_sampling)
        self.panel_calib.model_kind_changed.connect(lambda _k: self.refresh_calibration())
        self.panel_calib.refit_requested.connect(self.refresh_calibration)
        self.panel_preview.mode_changed.connect(self.update_preview)
        self.panel_preview.export_requested.connect(self.export_image)
        self.panel_preview.save_settings_requested.connect(self.save_settings_as)

    # ================= 数据加载 =================
    def choose_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图片", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)"
        )
        if path:
            self.load_image_file(path)

    def load_image_file(self, path: str) -> None:
        try:
            self.image = load_image(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        self.image_path = path
        self.view.clear_rois()
        self._reset_calibration()
        self._show_original()
        self.statusBar().showMessage(f"已加载图片：{path}（{self.image.shape[1]}x{self.image.shape[0]}）")

    def choose_reference(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开参考色卡", "", "色卡数据 (*.csv);;所有文件 (*)"
        )
        if path:
            self.load_reference_file(path)

    def load_reference_file(self, path: str) -> None:
        try:
            self.references = load_reference(path)
        except ReferenceError as exc:
            QMessageBox.critical(self, "色卡文件有误", str(exc))
            return
        self.reference_path = path
        self.ref_lookup = {p.id: p for p in self.references}
        self.panel_sample.set_references(self.references)
        self.statusBar().showMessage(f"已加载参考色卡：{path}（{len(self.references)} 格）")
        self.refresh_sampling()

    def reload_reference(self) -> None:
        """调参考数据期间只重读目标色，输入图与取样框保持不变。"""
        if not self.reference_path:
            QMessageBox.information(self, "提示", "还没有打开参考色卡文件")
            return
        # 内置样例：从生成器重建参考数据，不依赖外部文件
        if self.reference_path == "<内置样例>":
            self.references = build_sample_image().references
            self.ref_lookup = {p.id: p for p in self.references}
            self.panel_sample.set_references(self.references)
            self.refresh_sampling()
            self.statusBar().showMessage("内置参考色卡已重新加载，输入图未改动")
            return
        if not os.path.exists(self.reference_path):
            QMessageBox.warning(self, "提示", f"文件不存在：{self.reference_path}")
            return
        try:
            refs = load_reference(self.reference_path)
        except ReferenceError as exc:
            QMessageBox.critical(self, "色卡文件有误", str(exc))
            return
        self.references = refs
        self.ref_lookup = {p.id: p for p in refs}
        self.panel_sample.set_references(refs)
        # 原图像素不动，仅重新取样计算（取样值只依赖原图与 ROI）
        self.refresh_sampling()
        self.statusBar().showMessage("参考色卡已重新加载，输入图未改动")

    def load_builtin_sample(self) -> None:
        sample = build_sample_image()
        self.image = sample.image.copy()
        self.image_path = "<内置样例>"
        self.references = sample.references
        self.reference_path = "<内置样例>"
        self.ref_lookup = {p.id: p for p in sample.references}
        self.project_path = ""
        self.view.set_image(QPixmap.fromImage(to_qimage(self.image)[0]))
        self.view.clear_rois()
        with QSignalBlocker(self.view):
            for roi in sample.rois:
                self.view.add_or_replace_roi(roi)
        self.panel_sample.set_references(sample.references)
        self.statusBar().showMessage(
            "内置样例：12 格色卡，已知暖色偏色 + B3 局部反光；可把 B3 停用、留两格做检查"
        )
        self.refresh_sampling()

    def choose_project(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开取样设置", "", "取样设置 (*.json);;所有文件 (*)"
        )
        if not path:
            return
        try:
            data = load_project(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "打开失败", str(exc))
            return
        if not data["image_path"] or not os.path.exists(data["image_path"]):
            QMessageBox.warning(
                self, "提示",
                f"设置中记录的原图片不存在：{data['image_path'] or '（空，可能来自内置样例）'}\n"
                "请先打开对应图片和参考色卡，再导入该设置。",
            )
            return
        self.load_image_file(data["image_path"])
        if data["reference_path"] and os.path.exists(data["reference_path"]):
            self.load_reference_file(data["reference_path"])
        with QSignalBlocker(self.view):
            for roi in data["rois"]:
                self.view.add_or_replace_roi(roi)
        self.panel_calib.set_kind(data["model_kind"])
        self.project_path = path
        self.refresh_sampling()

    # ================= 取样 =================
    def on_rois_changed(self) -> None:
        # 图上改动后同步面板当前色格控件
        rois = self.view.get_rois()
        pid = self.panel_sample._current_id()
        for roi in rois:
            if roi.patch_id == pid:
                self.panel_sample.sync_from_roi(roi.role, roi.enabled)
        self.refresh_sampling()

    def on_patch_selected(self, patch_id: str) -> None:
        """色格下拉/表格行切换时，让角色与停用控件跟随该色格的实际状态。"""
        for roi in self.view.get_rois():
            if roi.patch_id == patch_id:
                self.panel_sample.sync_from_roi(roi.role, roi.enabled)
                return
        # 还没有取样框的色格：恢复默认控件状态
        self.panel_sample.sync_from_roi("fit", True)

    def apply_role(self, patch_id: str, role: str) -> None:
        for roi in self.view.get_rois():
            if roi.patch_id == patch_id:
                roi.role = role
                self.view.update_roi_meta(roi)
        self.refresh_sampling()

    def apply_enabled(self, patch_id: str, enabled: bool) -> None:
        for roi in self.view.get_rois():
            if roi.patch_id == patch_id:
                roi.enabled = enabled
                self.view.update_roi_meta(roi)
        self.refresh_sampling()

    def refresh_sampling(self) -> None:
        if self.image is None:
            return
        rois = self.view.get_rois()
        self.samples = sample_all(self.image, rois)
        roi_lookup = {r.patch_id: r for r in rois}
        self.panel_sample.update_samples(self.samples, roi_lookup)

        states = {}
        for pid, s in self.samples.items():
            states[pid] = {
                "warning": s.overexposed or s.border_risk,
                "selected": pid == self.panel_sample._current_id(),
            }
        self.view.update_states(states)
        self.refresh_calibration()

    # ================= 拟合 =================
    def _reset_calibration(self) -> None:
        self.model_full = self.model_wb = None
        self.corrected_full = self.corrected_wb = None
        self.clip_mask_full = None
        self.calib_error = ""

    def _fit_data(self) -> tuple[np.ndarray, np.ndarray, list[str]]:
        measured, target, ids = [], [], []
        for roi in self.view.get_rois():
            pid = roi.patch_id
            s = self.samples.get(pid)
            ref = self.ref_lookup.get(pid)
            if s is None or ref is None:
                continue
            if not roi.enabled or not s.usable or roi.role != "fit":
                continue
            measured.append(s.median_rgb)
            target.append(np.asarray(ref.rgb, dtype=np.float64))
            ids.append(pid)
        if not measured:
            return np.empty((0, 3)), np.empty((0, 3)), ids
        return np.asarray(measured), np.asarray(target), ids

    def refresh_calibration(self) -> None:
        if self.image is None or not self.samples:
            return
        self._reset_calibration()
        measured, target, ids = self._fit_data()
        kind = "full" if self.panel_calib.rb_full.isChecked() else "white_balance"

        try:
            self.model_full = calib.fit_model(measured, target, ids, "full")
        except calib.CalibrationError as exc:
            # full 失败时仍尝试白平衡，并把失败原因展示出来
            self.calib_error = str(exc)
            self.model_full = None
        try:
            self.model_wb = calib.fit_model(measured, target, ids, "white_balance")
        except calib.CalibrationError as exc:
            self.model_wb = None
            if self.model_full is None:
                self.calib_error = str(exc)

        active = self.model_full if kind == "full" else self.model_wb
        if active is None:
            residuals = calib.compute_residuals(
                self.samples, self.ref_lookup, self.view.get_rois(), None
            )
            self.panel_calib.show_failure(self.calib_error or "有效色格不足")
            self.panel_calib.update_residuals(residuals)
            self.panel_preview.export_btn.setEnabled(False)
            self._show_original()
            self.panel_preview.update_info(0, self.image.shape[0] * self.image.shape[1], None)
            return

        self.panel_preview.export_btn.setEnabled(True)
        self.corrected_full = self.model_full.apply_srgb(self.image) if self.model_full else None
        self.corrected_wb = self.model_wb.apply_srgb(self.image) if self.model_wb else None
        _, self.clip_mask_full = clip_srgb(
            self.corrected_full if self.corrected_full is not None else self.image
        )

        model_for_table = active
        residuals = calib.compute_residuals(
            self.samples, self.ref_lookup, self.view.get_rois(), model_for_table
        )
        held_out = [r for r in residuals if r.excluded_reason]
        self.panel_calib.show_model(model_for_table, held_out)
        self.panel_calib.update_residuals(residuals)
        self.update_preview()

    # ================= 预览 / 导出 =================
    def _show_original(self) -> None:
        if self.image is not None:
            qimg, _ = to_qimage(self.image)
            self.view.set_pixmap(QPixmap.fromImage(qimg))

    def update_preview(self) -> None:
        if self.image is None:
            return
        mode = self.panel_preview.mode_combo.currentData()
        kind = "full" if self.panel_calib.rb_full.isChecked() else "white_balance"
        active = self.model_full if kind == "full" else self.model_wb

        total = self.image.shape[0] * self.image.shape[1]
        wb_delta = None

        if mode == "original" or active is None:
            qimg, _ = to_qimage(self.image)
            clip_count = 0
        elif mode == "white_balance":
            if self.model_wb is None:
                qimg, _ = to_qimage(self.image)
                clip_count = 0
            else:
                qimg, mask = to_qimage(self.corrected_wb)
                clip_count = int(mask.sum())
        elif mode == "clipping":
            base = self.corrected_full if self.corrected_full is not None else self.image
            base_uint8, mask = to_uint8(base)
            # 越界像素用半透明红色罩染（向量化，避免逐像素绘制）
            tinted = base_uint8.copy()
            red = np.array([231, 76, 60], dtype=np.float64)
            tinted[mask] = np.round(0.45 * tinted[mask] + 0.55 * red).astype(np.uint8)
            qimg, _ = to_qimage(tinted)
            clip_count = int(mask.sum())
        else:  # corrected
            img = self.corrected_full if kind == "full" else self.corrected_wb
            if img is None:
                qimg, _ = to_qimage(self.image)
                clip_count = 0
            else:
                qimg, mask = to_qimage(img)
                clip_count = int(mask.sum())
                if self.corrected_full is not None and self.corrected_wb is not None:
                    lab_full = srgb_array_to_lab(np.clip(self.corrected_full, 0, 255))
                    lab_wb = srgb_array_to_lab(np.clip(self.corrected_wb, 0, 255))
                    wb_delta = float(np.mean(delta_e(lab_full, lab_wb)))

        self.view.set_pixmap(QPixmap.fromImage(qimg))
        states = {
            pid: {"warning": s.overexposed or s.border_risk}
            for pid, s in self.samples.items()
        }
        self.view.update_states(states)
        self.panel_preview.update_info(clip_count, total, wb_delta)

    def export_image(self, path: str) -> None:
        kind = "full" if self.panel_calib.rb_full.isChecked() else "white_balance"
        active = self.model_full if kind == "full" else self.model_wb
        if active is None:
            QMessageBox.warning(self, "无法导出", "当前没有可靠的修正模型")
            return
        img = self.corrected_full if kind == "full" else self.corrected_wb
        # 与预览完全相同的裁剪规则
        uint8, mask = to_uint8(img)
        qimg, _ = to_qimage(uint8)
        if not qimg.save(path, "PNG"):
            QMessageBox.critical(self, "导出失败", f"无法写入：{path}")
            return
        self.statusBar().showMessage(
            f"已导出：{path}（{int(mask.sum())} 个越界像素按预览同规则裁剪）"
        )

    # ================= 项目保存 =================
    def save_settings_as(self) -> None:
        if self.image is None:
            QMessageBox.information(self, "提示", "还没有加载图片")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存取样设置", self.project_path or "calibration_settings.json",
            "取样设置 (*.json)",
        )
        if not path:
            return
        kind = "full" if self.panel_calib.rb_full.isChecked() else "white_balance"
        is_builtin = self.image_path == "<内置样例>"
        save_project(
            path,
            image_path="" if is_builtin else self.image_path,
            reference_path="" if is_builtin else self.reference_path,
            rois=self.view.get_rois(),
            model_kind=kind,
        )
        self.project_path = path
        if is_builtin:
            self.statusBar().showMessage(
                f"取样设置已保存：{path}（内置样例无磁盘路径，重开前请先打开图片与 examples/sample_reference.csv）"
            )
        else:
            self.statusBar().showMessage(f"取样设置已保存：{path}")
