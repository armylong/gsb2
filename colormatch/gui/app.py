"""主窗口：工程管理、框选采样、拟合控制、色差对比与越界可视化。"""
from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QWidget,
    QHBoxLayout,
    QVBoxLayout,
    QSplitter,
    QPushButton,
    QLabel,
    QComboBox,
    QCheckBox,
    QTableWidget,
    QTableWidgetItem,
    QFileDialog,
    QMessageBox,
    QScrollArea,
    QGroupBox,
    QHeaderView,
    QPlainTextEdit,
)

from ..core import (
    Project,
    ImageEntry,
    Sample,
    Rect,
    FitError,
    FitParams,
    load_image_rgb,
    file_sha256,
    apply_transform,
    gamut_stats,
    gamut_mask,
)
from ..pipeline import fit_all, foreground_mask, gamut_overlay, check_integrity
from ..samples import generate_sample_project
from .canvas import ImageCanvas


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("颜色一致性校对工具")
        self.resize(1500, 920)

        self.project: Project | None = None
        self.project_path: str | None = None
        self.images: dict[str, np.ndarray] = {}
        self.canvases: dict[str, ImageCanvas] = {}
        self.fit_results: dict[str, object] = {}
        self.transformed: dict[str, np.ndarray] = {}

        self._build_ui()
        self._build_menu()
        self._set_enabled(False)

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # 左：图像画布区
        self.canvas_host = QWidget()
        self.canvas_host.setMinimumWidth(900)
        self.canvas_layout = QHBoxLayout(self.canvas_host)
        self.canvas_layout.setContentsMargins(4, 4, 4, 4)
        left_scroll = QScrollArea()
        left_scroll.setWidgetResizable(True)
        left_scroll.setWidget(self.canvas_host)
        splitter.addWidget(left_scroll)

        # 右：控制面板
        right = QWidget()
        right_layout = QVBoxLayout(right)

        fit_box = QGroupBox("拟合设置")
        fb = QVBoxLayout(fit_box)
        row = QHBoxLayout()
        row.addWidget(QLabel("模型"))
        self.method_combo = QComboBox()
        self.method_combo.addItem("仿射 affine（至少 4 组采样）", "affine")
        self.method_combo.addItem("对角 diagonal（至少 2 组采样）", "diagonal")
        row.addWidget(self.method_combo)
        fb.addLayout(row)

        self.white_lock_cb = QCheckBox("锁定白点（硬约束 M·xs+t = ys）")
        self.white_lock_cb.setChecked(True)
        fb.addWidget(self.white_lock_cb)
        row2 = QHBoxLayout()
        row2.addWidget(QLabel("白点采样"))
        self.white_combo = QComboBox()
        row2.addWidget(self.white_combo)
        fb.addLayout(row2)

        btn_row = QHBoxLayout()
        self.fit_btn = QPushButton("拟合颜色变换")
        self.fit_btn.clicked.connect(self.run_fit)
        btn_row.addWidget(self.fit_btn)
        self.export_btn = QPushButton("分别导出处理后图像")
        self.export_btn.clicked.connect(self.export_all)
        btn_row.addWidget(self.export_btn)
        fb.addLayout(btn_row)
        right_layout.addWidget(fit_box)

        # 采样表
        samp_box = QGroupBox("采样色块（选中一行后，在任意图上拖拽即可替换该图矩形）")
        sb = QVBoxLayout(samp_box)
        self.sample_table = QTableWidget(0, 4)
        self.sample_table.setHorizontalHeaderLabels(["名称", "白点", "参考图矩形", "源图覆盖"])
        self.sample_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.sample_table.itemSelectionChanged.connect(self._on_sample_selected)
        sb.addWidget(self.sample_table)
        add_row = QHBoxLayout()
        add_btn = QPushButton("新增采样")
        add_btn.clicked.connect(self.add_sample)
        del_btn = QPushButton("删除选中")
        del_btn.clicked.connect(self.delete_sample)
        add_row.addWidget(add_btn)
        add_row.addWidget(del_btn)
        sb.addLayout(add_row)
        right_layout.addWidget(samp_box)

        # 结果表
        res_box = QGroupBox("处理前后色差对比（CIEDE2000）")
        rb = QVBoxLayout(res_box)
        self.source_combo = QComboBox()
        self.source_combo.currentIndexChanged.connect(self._refresh_results)
        rb.addWidget(self.source_combo)
        self.result_table = QTableWidget(0, 4)
        self.result_table.setHorizontalHeaderLabels(["色块", "处理前 dE00", "处理后 dE00", "改善"])
        self.result_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        rb.addWidget(self.result_table)
        self.param_label = QLabel("尚未拟合")
        self.param_label.setWordWrap(True)
        self.param_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        rb.addWidget(self.param_label)
        right_layout.addWidget(res_box)

        # 越界可视化
        gam_box = QGroupBox("超出颜色范围（[0,1] 之外）的区域")
        gb = QVBoxLayout(gam_box)
        self.gamut_cb = QCheckBox("在源图画布上红色叠加显示越界像素")
        self.gamut_cb.toggled.connect(self._refresh_gamut)
        gb.addWidget(self.gamut_cb)
        self.gamut_label = QLabel("尚无结果")
        self.gamut_label.setWordWrap(True)
        gb.addWidget(self.gamut_label)
        right_layout.addWidget(gam_box)

        # 日志/提示
        log_box = QGroupBox("提示与诊断")
        lb = QVBoxLayout(log_box)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(500)
        lb.addWidget(self.log)
        right_layout.addWidget(log_box)

        splitter.addWidget(right)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([950, 550])
        self.setCentralWidget(splitter)

        self.method_combo.currentIndexChanged.connect(self._on_method_changed)
        self.white_lock_cb.toggled.connect(self._on_white_lock_toggled)
        self.white_combo.currentIndexChanged.connect(self._on_white_chosen)

    def _build_menu(self) -> None:
        bar = self.menuBar()
        m_file = bar.addMenu("文件")
        for text, slot in (
            ("生成样例工程（程序内造图）…", self.demo_project),
            ("打开工程…", self.open_project),
            ("保存工程", self.save_project),
            ("工程另存为…", self.save_project_as),
        ):
            act = QAction(text, self)
            act.triggered.connect(slot)
            m_file.addAction(act)
        m_file.addSeparator()
        act_import_ref = QAction("导入参考图…", self)
        act_import_ref.triggered.connect(lambda: self.import_image("reference"))
        act_import_src = QAction("导入源图…", self)
        act_import_src.triggered.connect(lambda: self.import_image("source"))
        m_file.addAction(act_import_ref)
        m_file.addAction(act_import_src)

    # ------------------------------------------------------------------ 工程
    def _set_enabled(self, on: bool) -> None:
        for w in (
            self.fit_btn, self.export_btn, self.method_combo, self.white_lock_cb,
            self.white_combo, self.sample_table, self.source_combo, self.gamut_cb,
        ):
            w.setEnabled(on)

    def _bind_project(self) -> None:
        self.canvases.clear()
        self.images.clear()
        # 清空旧画布
        while self.canvas_layout.count():
            item = self.canvas_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        project_dir = os.path.dirname(self.project_path or "")
        for entry in self.project.images:
            path = entry.path if os.path.isabs(entry.path) else os.path.join(project_dir, entry.path)
            img = load_image_rgb(path)
            self.images[entry.id] = img
            canvas = ImageCanvas(entry.id, f"{entry.role}: {os.path.basename(entry.path)}")
            canvas.set_image(img)
            canvas.rectDrawn.connect(self.on_rect_drawn)
            self.canvases[entry.id] = canvas
            self.canvas_layout.addWidget(canvas)

        self.method_combo.setCurrentIndex(
            0 if self.project.settings.get("method", "affine") == "affine" else 1
        )
        self.white_lock_cb.setChecked(bool(self.project.settings.get("lock_white", False)))
        self._reload_white_combo()
        self.source_combo.clear()
        for src in self.project.sources:
            self.source_combo.addItem(os.path.basename(src.path), src.id)

        self.fit_results = {}
        self.transformed = {}
        self.gamut_cb.setChecked(False)
        self._refresh_sample_table()
        self._refresh_canvas_rects()
        self.result_table.setRowCount(0)
        self.param_label.setText("尚未拟合")
        self.gamut_label.setText("尚无结果")
        self._set_enabled(True)
        self._append_log(f"已加载工程：{self.project_path}，共 {len(self.project.images)} 张图、"
                         f"{len(self.project.samples)} 个采样")
        problems = (
            check_integrity(self.project, os.path.dirname(os.path.abspath(self.project_path)))
            if self.project_path
            else []
        )
        for p in problems:
            self._append_log("[哈希] " + p)

    def demo_project(self) -> None:
        out = QFileDialog.getExistingDirectory(self, "选择样例工程输出目录（需为空目录）")
        if not out:
            return
        try:
            path = generate_sample_project(out)
        except (FileExistsError, OSError) as e:
            QMessageBox.warning(self, "生成失败", str(e))
            return
        self.project_path = path
        self.project = Project.load(path)
        self._bind_project()

    def open_project(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开工程", "", "工程文件 (*.json)")
        if not path:
            return
        try:
            project = Project.load(path)
        except Exception as e:  # 工程文件损坏
            QMessageBox.critical(self, "打开失败", f"工程文件无法解析：{e}")
            return
        self.project_path = path
        self.project = project
        self._bind_project()

    def _ensure_saved_location(self) -> bool:
        if self.project_path is None:
            return self.save_project_as()
        return True

    def save_project(self) -> bool:
        if self.project is None:
            return False
        if not self._ensure_saved_location():
            return False
        self.project.save(self.project_path)
        self._append_log(f"工程已保存：{self.project_path}")
        return True

    def save_project_as(self) -> bool:
        if self.project is None:
            return False
        path, _ = QFileDialog.getSaveFileName(self, "工程另存为", "project.json", "工程文件 (*.json)")
        if not path:
            return False
        self.project_path = path
        self.project.save(path)
        self._append_log(f"工程已另存：{path}")
        return True

    def import_image(self, role: str) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择图像", "", "图像 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp)"
        )
        if not paths:
            return
        if self.project is None:
            self.project = Project(images=[], samples=[], fits={})
        for p in paths:
            if role == "reference" and self.project.reference is not None:
                QMessageBox.warning(self, "已存在参考图", "一个工程只允许一张参考图，已忽略后续选择")
                break
            img = load_image_rgb(p)
            entry = ImageEntry(
                id=f"img_{len(self.project.images) + 1}",
                path=os.path.abspath(p),
                role=role,
                sha256=file_sha256(p),
                width=img.shape[1],
                height=img.shape[0],
            )
            self.project.images.append(entry)
        self._bind_project()

    # ------------------------------------------------------------------ 采样
    def add_sample(self) -> None:
        idx = len(self.project.samples)
        sid = f"s{idx:02d}"
        self.project.samples.append(Sample(id=sid, name=f"采样{idx + 1}"))
        self._reload_white_combo()
        self._refresh_sample_table()
        self._refresh_canvas_rects()
        self.sample_table.selectRow(self.sample_table.rowCount() - 1)

    def delete_sample(self) -> None:
        row = self.sample_table.currentRow()
        if row < 0:
            return
        sid = self.project.samples[row].id
        del self.project.samples[row]
        if self.project.settings.get("white_sample_id") == sid:
            self.project.settings["white_sample_id"] = None
            self._reload_white_combo()
        self._refresh_sample_table()
        self._refresh_canvas_rects()

    def on_rect_drawn(self, image_id: str, rect: Rect) -> None:
        sample = self._current_sample()
        if sample is None:
            self._append_log("请先在采样表中选中一个采样，再在图上拖拽框选")
            return
        sample.rects[image_id] = rect
        self._append_log(f"采样「{sample.name}」在 {image_id} 上更新矩形 {rect}")
        self._refresh_sample_table()
        self._refresh_canvas_rects()

    def _current_sample(self) -> Sample | None:
        row = self.sample_table.currentRow()
        if row < 0 or row >= len(self.project.samples):
            return None
        return self.project.samples[row]

    def _on_sample_selected(self) -> None:
        self._refresh_canvas_rects()

    def _reload_white_combo(self) -> None:
        self.white_combo.blockSignals(True)
        self.white_combo.clear()
        self.white_combo.addItem("（未指定）", None)
        current = self.project.settings.get("white_sample_id")
        select = 0
        for i, s in enumerate(self.project.samples, start=1):
            self.white_combo.addItem(s.name, s.id)
            if s.id == current:
                select = i
        self.white_combo.setCurrentIndex(select)
        self.white_combo.blockSignals(False)

    def _on_white_chosen(self) -> None:
        sid = self.white_combo.currentData()
        for s in self.project.samples:
            s.is_white = (s.id == sid)
        self.project.settings["white_sample_id"] = sid
        self._refresh_sample_table()
        self._refresh_canvas_rects()

    def _on_method_changed(self) -> None:
        self.project.settings["method"] = self.method_combo.currentData()

    def _on_white_lock_toggled(self) -> None:
        self.project.settings["lock_white"] = self.white_lock_cb.isChecked()

    def _refresh_sample_table(self) -> None:
        if self.project is None:
            self.sample_table.setRowCount(0)
            return
        self.sample_table.blockSignals(True)
        keep_row = self.sample_table.currentRow()
        self.sample_table.setRowCount(len(self.project.samples))
        ref_entry = self.project.reference
        ref_id = ref_entry.id if ref_entry else None
        n_src = len(self.project.sources)
        for i, s in enumerate(self.project.samples):
            self.sample_table.setItem(i, 0, QTableWidgetItem(s.name + ("  ★白点" if s.is_white else "")))
            self.sample_table.setItem(i, 1, QTableWidgetItem("是" if s.is_white else ""))
            rr = s.rects.get(ref_id) if ref_id else None
            self.sample_table.setItem(
                i, 2, QTableWidgetItem(f"({rr.x},{rr.y},{rr.w}×{rr.h})" if rr else "—")
            )
            covered = sum(1 for src in self.project.sources if src.id in s.rects)
            self.sample_table.setItem(i, 3, QTableWidgetItem(f"{covered}/{n_src}"))
        if 0 <= keep_row < self.sample_table.rowCount():
            self.sample_table.selectRow(keep_row)
        self.sample_table.blockSignals(False)

    def _refresh_canvas_rects(self) -> None:
        current = self._current_sample()
        sel_id = current.id if current else None
        if self.project is None:
            return
        for cid, canvas in self.canvases.items():
            rects = {
                s.id: (s.rects[cid], s.is_white)
                for s in self.project.samples
                if cid in s.rects
            }
            canvas.set_rectangles(rects, sel_id)

    # ------------------------------------------------------------------ 拟合
    def run_fit(self) -> None:
        if self.project is None:
            return
        self.project.settings["method"] = self.method_combo.currentData()
        self.project.settings["lock_white"] = self.white_lock_cb.isChecked()
        self.project.settings["white_sample_id"] = self.white_combo.currentData()
        try:
            self.fit_results = fit_all(self.project, self.images)
        except FitError as e:
            QMessageBox.warning(self, "无法拟合", str(e))
            self._append_log("[拟合失败] " + str(e))
            return

        # 预算每张源图的变换结果与越界统计
        self.transformed = {}
        for src in self.project.sources:
            params = self.fit_results[src.id].params
            t_img = apply_transform(self.images[src.id], params)
            self.transformed[src.id] = t_img

        self._refresh_results()
        self._refresh_gamut()
        for sid, result in self.fit_results.items():
            self._append_log(
                f"{sid} 拟合完成：模型={result.params.method} 采样={result.params.n_samples} "
                f"残差RMS={result.params.residual_rms:.3f}/255"
            )
            for w in result.params.warnings:
                self._append_log("[警告] " + w)
        if self.save_project():
            self._append_log("拟合参数已随工程保存，重开可复现")

    def _current_source_id(self) -> str | None:
        return self.source_combo.currentData()

    def _refresh_results(self) -> None:
        sid = self._current_source_id()
        if sid is None or sid not in self.fit_results:
            if sid is not None:
                self.param_label.setText("该源图尚未拟合，请点击「拟合颜色变换」")
            return
        result = self.fit_results[sid]
        self.result_table.setRowCount(len(result.errors))
        for i, e in enumerate(result.errors):
            improved = e.delta_e_before - e.delta_e_after
            items = [
                QTableWidgetItem(e.sample_name),
                QTableWidgetItem(f"{e.delta_e_before:.2f}"),
                QTableWidgetItem(f"{e.delta_e_after:.2f}"),
                QTableWidgetItem(f"↓{improved:.2f}"),
            ]
            if e.delta_e_after > 2.0:
                for it in items:
                    it.setBackground(Qt.GlobalColor.yellow)
            for c, it in enumerate(items):
                if c:
                    it.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                self.result_table.setItem(i, c, it)

        p = result.params
        M = np.asarray(p.M)
        t = np.asarray(p.t)
        matrix_text = "\n".join("  ".join(f"{v:+.4f}" for v in row) for row in M)
        mean_before = np.mean([e.delta_e_before for e in result.errors])
        mean_after = np.mean([e.delta_e_after for e in result.errors])
        self.param_label.setText(
            f"模型={p.method}，白点锁定={p.white_locked}，采样数={p.n_samples}，秩={p.rank}，"
            f"条件数={p.condition_number:.2e}\nM =\n{matrix_text}\nt = "
            f"({t[0]:+.4f}, {t[1]:+.4f}, {t[2]:+.4f})\n"
            f"平均 dE00：{mean_before:.2f} → {mean_after:.2f}"
        )

    # ------------------------------------------------------------------ 越界
    def _refresh_gamut(self) -> None:
        sid = self._current_source_id()
        if sid is None or sid not in self.transformed:
            return
        t_img = self.transformed[sid]
        valid = foreground_mask(self.images[sid])
        stats = gamut_stats(t_img, valid)
        fg = stats["foreground"]
        ch_text = []
        for c, name in enumerate(("R", "G", "B")):
            ch = fg["per_channel"][c]
            if ch["under"] or ch["over"]:
                ch_text.append(f"{name}: 欠{100 * ch['under']:.2f}% 过{100 * ch['over']:.2f}%")
        self.gamut_label.setText(
            f"有效内容越界 {fg['n_out']}/{fg['n_pixels']} 像素 "
            f"({100 * fg['out_of_gamut_fraction']:.2f}%)；全图口径 "
            f"{100 * stats['out_of_gamut_fraction']:.2f}%\n" + "；".join(ch_text)
        )
        show = self.gamut_cb.isChecked()
        for src in self.project.sources:
            canvas = self.canvases[src.id]
            if show and src.id in self.transformed:
                overlay = gamut_overlay(self.images[src.id], gamut_mask(self.transformed[src.id]))
                canvas.set_image(overlay)
            else:
                canvas.set_image(self.images[src.id])
        self._refresh_canvas_rects()

    # ------------------------------------------------------------------ 导出
    def export_all(self) -> None:
        if not self.fit_results:
            QMessageBox.information(self, "提示", "请先完成拟合再导出")
            return
        if not self._ensure_saved_location():
            return
        export_dir = QFileDialog.getExistingDirectory(
            self, "选择导出目录", os.path.dirname(self.project_path)
        )
        if not export_dir:
            return
        from ..core import save_image_rgb

        saved = []
        for src in self.project.sources:
            base = os.path.splitext(os.path.basename(src.path))[0]
            out = os.path.join(export_dir, f"{base}_matched.png")
            save_image_rgb(out, self.transformed[src.id])
            saved.append(out)
        self._append_log("已导出：\n  " + "\n  ".join(saved))
        QMessageBox.information(self, "导出完成", f"已导出 {len(saved)} 张：\n" + "\n".join(saved))

    def _append_log(self, text: str) -> None:
        self.log.appendPlainText(text)


def run_gui() -> int:
    import sys

    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
