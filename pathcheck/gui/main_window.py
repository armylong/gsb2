"""Main window: import/generate -> inspect -> tune simplification -> export."""

from __future__ import annotations

import os
import time
import traceback

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QColor, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QStatusBar,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..export import read_json, write_json, write_raster, write_rgb
from ..pipeline import Analysis, analyse
from ..render import overlay_diff, raster_diff, render_boundaries
from ..report import format_report
from ..samples import SAMPLES, SAMPLES_BY_KEY, generate_sample, load_mask
from ..simplify import METHODS, SimplifyParams
from ..validate import ring_border_spans
from .canvas import Canvas, OverlayRing

LEVEL_COLOUR = {
    "error": "#ff6b6b",
    "warning": "#ffc857",
    "info": "#6bcBff",
}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("边界检查器 — 二值图 -> 可缩放闭合路径")
        self.resize(1280, 860)

        self.mask: np.ndarray | None = None
        self.reference_path: str | None = None
        self.analysis: Analysis | None = None
        self.selected_label: str | None = None
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(140)
        self._debounce.timeout.connect(self.recompute)

        self._build_actions()
        self._build_ui()
        self._build_status()
        self.load_sample("metaballs")

    # ------------------------------------------------------------------ UI
    def _build_actions(self) -> None:
        menu = self.menuBar()
        file_menu = menu.addMenu("文件(&F)")
        act_open = QAction("导入黑白图片…", self, shortcut=QKeySequence.Open)
        act_open.triggered.connect(self.import_image)
        file_menu.addAction(act_open)
        file_menu.addSeparator()
        for spec in SAMPLES:
            act = QAction(f"生成样例: {spec.title}", self)
            act.triggered.connect(lambda _=False, k=spec.key: self.load_sample(k))
            file_menu.addAction(act)
        file_menu.addSeparator()
        act_export = QAction("导出路径 JSON + 栅格预览…", self, shortcut=QKeySequence.Save)
        act_export.triggered.connect(self.export_bundle)
        file_menu.addAction(act_export)
        act_reload = QAction("重新加载导出的 JSON…", self)
        act_reload.triggered.connect(self.reload_json)
        file_menu.addAction(act_reload)
        file_menu.addSeparator()
        act_quit = QAction("退出", self, shortcut=QKeySequence.Quit)
        act_quit.triggered.connect(self.close)
        file_menu.addAction(act_quit)

        view_menu = menu.addMenu("视图(&V)")
        act_fit = QAction("适应窗口", self, shortcut="F")
        act_fit.triggered.connect(lambda: self.canvas.fit())
        view_menu.addAction(act_fit)
        act_1to1 = QAction("1:1", self, shortcut="1")
        act_1to1.triggered.connect(lambda: self.canvas.one_to_one())
        view_menu.addAction(act_1to1)

    def _build_ui(self) -> None:
        self.canvas = Canvas()
        self.canvas.clicked.connect(self.select_ring)
        self.canvas.hovered.connect(self._hover_ring)

        # ---- left: parameters
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(8, 8, 8, 8)

        src_box = QGroupBox("输入")
        sl = QVBoxLayout(src_box)
        self.sample_combo = QComboBox()
        for spec in SAMPLES:
            self.sample_combo.addItem(spec.title, spec.key)
        btn_sample = QPushButton("生成样例")
        btn_sample.clicked.connect(
            lambda: self.load_sample(self.sample_combo.currentData())
        )
        btn_open = QPushButton("导入黑白图片…")
        btn_open.clicked.connect(self.import_image)
        sl.addWidget(self.sample_combo)
        row = QHBoxLayout()
        row.addWidget(btn_sample)
        row.addWidget(btn_open)
        sl.addLayout(row)
        self.source_label = QLabel("—")
        self.source_label.setWordWrap(True)
        sl.addWidget(self.source_label)
        lv.addWidget(src_box)

        simp_box = QGroupBox("简化")
        fl = QFormLayout(simp_box)
        self.method_combo = QComboBox()
        for key, title in METHODS.items():
            self.method_combo.addItem(f"{title}", key)
        self.method_combo.currentIndexChanged.connect(self._params_changed)
        fl.addRow("方法", self.method_combo)

        self.eps_spin = QDoubleSpinBox()
        self.eps_spin.setRange(0.0, 32.0)
        self.eps_spin.setSingleStep(0.1)
        self.eps_spin.setDecimals(2)
        self.eps_spin.setValue(0.5)
        self.eps_spin.valueChanged.connect(self._params_changed)
        fl.addRow("epsilon (px)", self.eps_spin)

        self.min_hole_spin = QDoubleSpinBox()
        self.min_hole_spin.setRange(0.0, 2000.0)
        self.min_hole_spin.setDecimals(1)
        self.min_hole_spin.setValue(0.0)
        self.min_hole_spin.setToolTip("洞面积 <= 该值 (像素) 时丢弃; 0 = 不丢")
        self.min_hole_spin.valueChanged.connect(self._params_changed)
        fl.addRow("丢弃小洞 <= px", self.min_hole_spin)

        self.allow_drop = QCheckBox("明确允许按策略丢弃洞 (默认禁止)")
        self.allow_drop.toggled.connect(self._params_changed)
        fl.addRow(self.allow_drop)

        self.wall_spin = QDoubleSpinBox()
        self.wall_spin.setRange(0.0, 10.0)
        self.wall_spin.setSingleStep(0.5)
        self.wall_spin.setDecimals(1)
        self.wall_spin.setValue(2.0)
        self.wall_spin.setToolTip("低于该厚度的细壁/细桥会被预警")
        self.wall_spin.valueChanged.connect(self._params_changed)
        fl.addRow("细壁预警 (px)", self.wall_spin)

        self.check_vertices = QCheckBox("显示顶点")
        self.check_vertices.setChecked(True)
        self.check_vertices.toggled.connect(self._update_canvas_flags)
        self.check_labels = QCheckBox("显示环标签 (C#/O, C#/H#)")
        self.check_labels.setChecked(True)
        self.check_labels.toggled.connect(self._update_canvas_flags)
        self.check_view = QComboBox()
        self.check_view.addItem("路径视图", "paths")
        self.check_view.addItem("差异视图", "diff")
        self.check_view.addItem("原始掩码", "mask")
        self.check_view.currentIndexChanged.connect(self._update_canvas_image)
        fl.addRow("视图", self.check_view)
        fl.addRow(self.check_vertices)
        fl.addRow(self.check_labels)
        lv.addWidget(simp_box)

        btn_scan = QPushButton("扫描首个失败 epsilon")
        btn_scan.setToolTip(
            "从 0.5px 开始逐步增大 epsilon, 找到第一个出现 error 级问题的值"
        )
        btn_scan.clicked.connect(self.scan_failure)
        lv.addWidget(btn_scan)

        btn_export = QPushButton("导出路径 + 预览…")
        btn_export.clicked.connect(self.export_bundle)
        btn_reload = QPushButton("重新加载 JSON 校验…")
        btn_reload.clicked.connect(self.reload_json)
        lv.addWidget(btn_export)
        lv.addWidget(btn_reload)
        lv.addStretch(1)

        # ---- right: notebook
        right = QTabWidget()
        self.ring_list = QListWidget()
        self.ring_list.currentItemChanged.connect(self._ring_item_changed)
        right.addTab(self.ring_list, "环 / 组件")
        self.issue_list = QListWidget()
        self.issue_list.currentItemChanged.connect(self._issue_item_changed)
        right.addTab(self.issue_list, "校验问题")
        self.report_view = QTextEdit()
        self.report_view.setReadOnly(True)
        self.report_view.setLineWrapMode(QTextEdit.NoWrap)
        right.addTab(self.report_view, "完整报告")
        self.detail_view = QTextEdit()
        self.detail_view.setReadOnly(True)
        right.addTab(self.detail_view, "选中环详情")

        splitter = QSplitter()
        splitter.addWidget(self.canvas)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        splitter.setSizes([880, 390])

        central = QWidget()
        hl = QHBoxLayout(central)
        hl.setContentsMargins(0, 0, 0, 0)
        hl.addWidget(left, 0)
        hl.addWidget(splitter, 1)
        self.setCentralWidget(central)

    def _build_status(self) -> None:
        bar = QStatusBar()
        self.setStatusBar(bar)
        self.status_label = QLabel("就绪")
        bar.addWidget(self.status_label)

    def _update_canvas_flags(self) -> None:
        self.canvas.show_vertices = self.check_vertices.isChecked()
        self.canvas.show_labels = self.check_labels.isChecked()
        self.canvas.update()

    def _update_canvas_image(self) -> None:
        self.refresh_canvas_image()

    # ------------------------------------------------------------- loading
    def load_sample(self, key: str) -> None:
        self.mask = generate_sample(key)
        self.reference_path = None
        spec = SAMPLES_BY_KEY[key]
        self.source_label.setText(f"样例 {spec.title}\n{spec.description}")
        self.sample_combo.setCurrentIndex(
            max(0, [s.key for s in SAMPLES].index(key))
        )
        self.recompute()

    def import_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "导入图片", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff);;所有文件 (*)"
        )
        if not path:
            return
        try:
            self.mask = load_mask(path)
        except Exception as exc:  # noqa: BLE001 - show to user
            QMessageBox.critical(self, "导入失败", str(exc))
            return
        self.reference_path = path
        self.source_label.setText(
            f"{os.path.basename(path)}\n{self.mask.shape[1]}x{self.mask.shape[0]}, "
            f"前景 {int(self.mask.sum())} px"
        )
        self.recompute()

    # ---------------------------------------------------------- recompute
    def _params_changed(self) -> None:
        self._debounce.start()

    def scan_failure(self) -> None:
        """Find the first epsilon whose simplification fails validation."""
        if self.mask is None:
            return
        from ..pipeline import find_first_failure

        hit = find_first_failure(
            self.mask,
            self._current_params(),
            max_eps=8.0,
            step=0.5,
            wall_px=float(self.wall_spin.value()),
            allow_dropped_holes=self.allow_drop.isChecked(),
        )
        if hit is None:
            self.status_label.setText("扫描到 8px 仍未出现 error 级问题")
            return
        eps, a = hit
        codes = ", ".join(sorted({i.code for i in a.report.errors}))
        self.eps_spin.setValue(eps)
        self.status_label.setText(
            f"首个失败 epsilon={eps:g}px: {codes} (已切换到该值, 便于查看偏离区域)"
        )

    def _current_params(self) -> SimplifyParams:
        return SimplifyParams(
            method=self.method_combo.currentData(),
            epsilon=float(self.eps_spin.value()),
            min_hole_area=float(self.min_hole_spin.value()),
        )

    def recompute(self) -> None:
        if self.mask is None:
            return
        t0 = time.perf_counter()
        try:
            self.analysis = analyse(
                self.mask,
                self._current_params(),
                allow_dropped_holes=self.allow_drop.isChecked(),
                wall_px=float(self.wall_spin.value()),
                tol_missing=0.0,
                tol_extra=0.0,
            )
        except Exception:  # noqa: BLE001 - surfaced in the report pane
            self.report_view.setPlainText(traceback.format_exc())
            self.status_label.setText("分析失败, 见『完整报告』")
            return
        dt = (time.perf_counter() - t0) * 1000.0
        a = self.analysis
        self._fill_rings()
        self._fill_issues()
        self.report_view.setPlainText(format_report(a))
        self.canvas.set_deviation(self._deviation_dict())
        self.refresh_canvas_image()
        self._sync_canvas_rings()
        r = a.report
        verdict = "通过" if r.ok else f"{len(r.errors)} 个 error"
        self.status_label.setText(
            f"{dt:.0f} ms | 组件 {r.components_ref}->{r.components_new} | "
            f"洞 {r.holes_ref}->{r.holes_new} | 面积 {r.area_ref}->{r.area_new} "
            f"(IoU {r.iou:.4f}) | {verdict}"
        )

    # ------------------------------------------------------------- tables
    def _fill_rings(self) -> None:
        self.ring_list.blockSignals(True)
        self.ring_list.clear()
        a = self.analysis
        if a is None:
            self.ring_list.blockSignals(False)
            return
        for ring in a.extraction.rings:
            res = next((r for r in a.rings if r.label == ring.label), None)
            dev = res.deviation.max_distance if res and res.deviation else 0.0
            border = ""
            if ring.border_spans:
                border = "  [触边闭环: " + ", ".join(
                    f"{s}{a_}-{b_}" for s, a_, b_ in ring.border_spans
                ) + "]"
            item = QListWidgetItem(
                f"{ring.label:8s} {ring.describe():26s} 面积 {ring.area:7.1f} "
                f"顶点 {len(ring.points):3d} 偏离 {dev:5.2f}px{border}"
            )
            item.setData(Qt.UserRole, ring.label)
            colour = QColor(LEVEL_COLOUR["info"])
            if ring.kind == "hole":
                colour = QColor("#ffc857")
            elif ring.kind == "notch":
                colour = QColor("#b0b0b0")
            item.setForeground(colour)
            self.ring_list.addItem(item)
        for res in a.rings:
            if res.dropped:
                item = QListWidgetItem(f"{res.label:8s} 已按策略丢弃")
                item.setData(Qt.UserRole, res.label)
                item.setForeground(QColor("#ff6b6b"))
                self.ring_list.addItem(item)
        self.ring_list.blockSignals(False)

    def _fill_issues(self) -> None:
        self.issue_list.clear()
        if self.analysis is None:
            return
        for issue in self.analysis.issues:
            tag = {"error": "错误", "warning": "警告", "info": "提示"}[issue.level]
            item = QListWidgetItem(f"[{tag}] {issue.code}\n    {issue.message}")
            item.setData(Qt.UserRole, issue.ring)
            item.setForeground(QColor(LEVEL_COLOUR[issue.level]))
            self.issue_list.addItem(item)
        if self.issue_list.count() == 0:
            item = QListWidgetItem("无问题")
            item.setForeground(QColor("#7bd88f"))
            self.issue_list.addItem(item)

    def _ring_item_changed(self, current, _previous) -> None:
        if current is None or self.analysis is None:
            return
        label = current.data(Qt.UserRole)
        if label:
            self.select_ring(label)

    def _issue_item_changed(self, current, _previous) -> None:
        if current is None or self.analysis is None:
            return
        label = current.data(Qt.UserRole)
        if label:
            self.select_ring(label)

    def _hover_ring(self, label: str) -> None:
        self.status_label.setText(f"悬停: {label}")

    def select_ring(self, label: str) -> None:
        if self.analysis is None:
            return
        self.selected_label = label
        res = next((r for r in self.analysis.rings if r.label == label), None)
        ring = next((r for r in self.analysis.extraction.rings if r.label == label), None)
        for i in range(self.ring_list.count()):
            item = self.ring_list.item(i)
            if item.data(Qt.UserRole) == label:
                self.ring_list.setCurrentItem(item)
                break
        if res is None or ring is None:
            return
        lines = [
            f"{ring.describe()}",
            f"方向: {'外环 (顺时针)' if ring.kind == 'outer' else '负向环 (逆时针)'}",
            f"像素面积: {ring.area:.1f}",
            f"原始顶点 {res.original_points} -> 简化 {res.simplified_points}",
            f"原始面积 {res.original_area:.2f} -> 简化面积 {res.simplified_area:.2f}",
            f"边界说明: {ring.border_description(self.analysis.width, self.analysis.height)}",
            f"简化后贴边段: {self._fmt_spans(ring_border_spans(res.simplified, self.analysis.width, self.analysis.height))}",
            f"嵌套深度: {ring.nesting_depth}",
        ]
        if res.deviation is not None:
            d = res.deviation
            lines += [
                "",
                f"最大偏离: {d.max_distance:.3f}px (epsilon {d.epsilon:g}px, "
                f"{'超限!' if not d.within else '在容差内'})",
                f"  原始点 {tuple(round(v, 2) for v in d.original_point)}",
                f"  简化点 {tuple(round(v, 2) for v in d.simplified_point)}",
                f"  区域 bbox {d.bbox}",
            ]
        lines += ["", "原始点:", _wrap_points(res.original)]
        lines += ["", "简化点:", _wrap_points(res.simplified)]
        self.detail_view.setPlainText("\n".join(lines))
        self._sync_canvas_rings()
        if res.deviation is not None and res.deviation.max_distance > 0:
            x, y = res.deviation.original_point
            self.canvas.center_on(x, y)

    @staticmethod
    def _fmt_spans(spans) -> str:
        if not spans:
            return "无"
        return ", ".join(f"{s} {a}..{b}" for s, a, b in spans)

    # ------------------------------------------------------------- canvas
    def _deviation_dict(self) -> dict | None:
        if self.analysis is None:
            return None
        selected = None
        if self.selected_label:
            selected = next(
                (r for r in self.analysis.kept_rings if r.label == self.selected_label),
                None,
            )
        res = selected if selected and selected.deviation else None
        dev = res.deviation if res is not None else self.analysis.worst_deviation
        if dev is None:
            return None
        return {
            "max_distance": dev.max_distance,
            "original_point": dev.original_point,
            "simplified_point": dev.simplified_point,
            "bbox": dev.bbox,
        }

    def refresh_canvas_image(self) -> None:
        a = self.analysis
        if a is None:
            return
        mode = self.check_view.currentData()
        if mode == "mask":
            rgb = np.zeros((a.height, a.width, 3), np.uint8)
            rgb[a.mask != 0] = (210, 220, 235)
            rgb[a.mask == 0] = (18, 19, 21)
            self.canvas.mode = "mask"
        elif mode == "diff":
            rgb = overlay_diff(a.mask, raster_diff(a.mask, a.rebuild))
            self.canvas.mode = "diff"
        else:
            proxies = [
                type("R", (), {"points": r.simplified})() for r in a.kept_rings
            ]
            rgb = render_boundaries(a.mask, [], scale=1)
            self.canvas.mode = "paths"
        self.canvas.set_image(rgb)

    def _sync_canvas_rings(self) -> None:
        a = self.analysis
        if a is None:
            return
        overlays = []
        for res in a.kept_rings:
            overlays.append(
                OverlayRing(
                    label=res.label,
                    comp_id=res.comp_id,
                    kind=res.kind,
                    index=res.index,
                    points=[(float(x), float(y)) for x, y in res.simplified],
                    border_spans=res.border_spans,
                    selected=(res.label == self.selected_label),
                    dropped=res.dropped,
                )
            )
        self.canvas.set_rings(overlays, self._deviation_dict())

    # ------------------------------------------------------------- export
    def export_bundle(self) -> None:
        if self.analysis is None:
            return
        default = self.reference_path or "pathcheck"
        stem = os.path.splitext(os.path.basename(default))[0] + ".paths.json"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出路径 JSON", stem, "JSON (*.json)"
        )
        if not path:
            return
        out_dir = os.path.dirname(path) or "."
        self.analysis.reference_name = os.path.basename(path).replace(
            ".paths.json", ".reference.png"
        )
        write_json(self.analysis.to_document(), path)
        write_raster(
            self.analysis.mask.astype(np.uint8) * 255,
            os.path.join(out_dir, self.analysis.reference_name),
        )
        write_raster(
            self.analysis.rebuild.astype(np.uint8) * 255,
            os.path.join(out_dir, os.path.basename(path).replace(".paths.json", ".rebuild.png")),
        )
        write_rgb(
            overlay_diff(self.analysis.mask, raster_diff(self.analysis.mask, self.analysis.rebuild)),
            os.path.join(out_dir, os.path.basename(path).replace(".paths.json", ".diff.png")),
        )
        self.status_label.setText(f"已导出 {path} (+ 参考/重建/差异 PNG)")

    def reload_json(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "重新加载路径 JSON", "", "JSON (*.json)")
        if not path:
            return
        try:
            doc = read_json(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "加载失败", str(exc))
            return
        from ..extract import extract
        from ..render import reconstruct
        from ..validate import compare_to_reference, validate_rings

        mask = self.mask
        if mask is None or mask.shape != (doc.height, doc.width):
            side = os.path.join(os.path.dirname(path), doc.meta.get("reference", {}).get("png", ""))
            if os.path.exists(side):
                mask = load_mask(side)
            if mask is None or mask.shape != (doc.height, doc.width):
                QMessageBox.warning(
                    self, "无法校验",
                    "当前掩码与路径画布不一致, 且找不到配套的参考 PNG",
                )
                return
        ex = extract(mask)

        def _lab(r):
            code = "O" if r.kind == "outer" else ("N" if r.kind == "notch" else f"H{r.index}")
            return f"C{r.comp}/{code}"

        entries = [(_lab(r), r.comp, r.kind, r.index, r.points, 0.0) for r in doc.rings]
        checks, issues = validate_rings(
            [e for e in entries if e[2] != "notch"], width=doc.width, height=doc.height
        )
        nc, ni = validate_rings(
            [e for e in entries if e[2] == "notch"],
            width=doc.width,
            height=doc.height,
            allow_dropped_holes=True,
            check_structure=False,
        )
        checks.extend(nc)
        issues.extend(ni)
        rings = [type("R", (), {"points": r.points})() for r in doc.rings]
        rebuild = reconstruct(rings, doc.width, doc.height)
        report = compare_to_reference(
            mask, rebuild, checks, issues,
            reference_components=len(ex.components),
            reference_holes=ex.hole_count,
        )
        msg = [
            f"文件: {os.path.basename(path)}",
            f"环 {len(doc.rings)}, 画布 {doc.width}x{doc.height}",
            f"面积 {report.area_ref} -> {report.area_new} "
            f"(缺失 {report.missing_pixels}, 多出 {report.extra_pixels}, IoU {report.iou:.5f})",
            f"组件 {report.components_ref} -> {report.components_new}  "
            f"洞 {report.holes_ref} -> {report.holes_new}",
            "",
        ]
        for issue in report.issues:
            msg.append(f"[{issue.level}] {issue.code}: {issue.message}")
        if not report.issues:
            msg.append("无问题")
        QMessageBox.information(
            self, "重新加载校验: " + ("通过" if report.ok else "未通过"),
            "\n".join(msg[:40]),
        )
        self.status_label.setText(
            f"重新加载 {os.path.basename(path)}: "
            + ("通过" if report.ok else f"{len(report.errors)} 个 error")
        )


def _wrap_points(points, per_line: int = 6) -> str:
    out = []
    for i in range(0, len(points), per_line):
        chunk = ", ".join(f"({x},{y})" for x, y in points[i:i + per_line])
        out.append("  " + chunk)
    return "\n".join(out)


def run() -> int:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName("pathcheck")
    win = MainWindow()
    win.show()
    return app.exec()
