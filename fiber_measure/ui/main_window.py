"""主窗口:加载图像 → 调阈值/ROI → 骨架路径 → 交叉配对 → 测长 → 导出。"""
from __future__ import annotations

import csv
import math

import cv2
import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QImage, QAction, QColor
from PySide6.QtWidgets import (QMainWindow, QWidget, QSplitter, QVBoxLayout,
                               QHBoxLayout, QGroupBox, QFormLayout, QLabel,
                               QPushButton, QSlider, QSpinBox, QCheckBox,
                               QDoubleSpinBox, QLineEdit, QTableWidget,
                               QTableWidgetItem, QListWidget, QListWidgetItem,
                               QFileDialog, QMessageBox, QAbstractItemView,
                               QScrollArea)

from ..core.maskops import MaskParams, make_mask, is_binary_image
from ..core.skeleton import skeletonize
from ..core.graph import build_graph
from ..core.paths import build_paths, pairing_options
from ..core.measure import path_length
from ..core import samples
from .image_view import ImageView, PATH_COLORS

MARK_MATCH_TOL = 6.0  # 重新分析后,交叉点在该距离内视为同一标记


def bgr_to_qimage(bgr: np.ndarray) -> QImage:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w, _ = rgb.shape
    return QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888).copy()


def mask_to_qimage(mask: np.ndarray) -> QImage:
    rgba = np.zeros((*mask.shape, 4), np.uint8)
    rgba[mask > 0] = (255, 0, 0, 255)
    h, w, _ = rgba.shape
    return QImage(rgba.data, w, h, 4 * w, QImage.Format_RGBA8888).copy()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("纤维长度测量")
        self.resize(1280, 800)

        # ---- 状态 ----
        self._bgr: np.ndarray | None = None      # 原图,永不修改
        self._gray: np.ndarray | None = None
        self._image_id = ""
        self._params = MaskParams()
        self._graph = None
        self._paths: list = []
        self._mask = None
        self._markings: dict = {}          # 当前图的 {crossing_node_id: 配对序号}
        self._invalid_markings: list = []  # [(位置, 配对序号)] 参数变化后失效的标记
        self._sample_meta = None
        self._selected_path_id = None

        self._debounce = QTimer(self, singleShot=True, interval=300)
        self._debounce.timeout.connect(self._reanalyze)

        self.view = ImageView()
        self.view.roiSelected.connect(self._on_roi_selected)
        self.view.crossingClicked.connect(self._on_crossing_clicked)

        self._build_panel()
        self._build_menus()

        splitter = QSplitter()
        splitter.addWidget(self.view)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self._panel)
        scroll.setMinimumWidth(380)
        scroll.setMaximumWidth(460)
        splitter.addWidget(scroll)
        splitter.setStretchFactor(0, 1)
        self.setCentralWidget(splitter)
        self.statusBar().showMessage("打开图像或从菜单加载样图开始")

    # ================= UI 构建 =================
    def _build_panel(self):
        self._panel = QWidget()
        lay = QVBoxLayout(self._panel)

        # --- 输入 ---
        gb = QGroupBox("输入")
        v = QVBoxLayout(gb)
        self.btn_open = QPushButton("打开图像…")
        self.btn_open.clicked.connect(self._open_image)
        v.addWidget(self.btn_open)
        self.lbl_input_type = QLabel("未加载图像")
        v.addWidget(self.lbl_input_type)
        lay.addWidget(gb)

        # --- 掩膜参数 ---
        gb = QGroupBox("掩膜(不修改原图)")
        f = QFormLayout(gb)
        row = QHBoxLayout()
        self.sld_thr = QSlider(Qt.Horizontal, minimum=0, maximum=255, value=128)
        self.spn_thr = QSpinBox(minimum=0, maximum=255, value=128)
        self.sld_thr.valueChanged.connect(self.spn_thr.setValue)
        self.spn_thr.valueChanged.connect(self.sld_thr.setValue)
        self.sld_thr.valueChanged.connect(self._params_changed)
        row.addWidget(self.sld_thr)
        row.addWidget(self.spn_thr)
        f.addRow("阈值", row)
        self.chk_dark = QCheckBox("纤维比背景暗(取反)")
        self.chk_dark.setChecked(True)
        self.chk_dark.toggled.connect(self._params_changed)
        f.addRow(self.chk_dark)
        self.spn_min = QSpinBox(minimum=0, maximum=1000000, value=8)
        self.spn_min.setToolTip("去除面积小于该值的孤立连通块(像素),0 = 不去除")
        self.spn_min.valueChanged.connect(self._params_changed)
        f.addRow("去小孤立点", self.spn_min)
        row = QHBoxLayout()
        self.btn_roi = QPushButton("框选分析区")
        self.btn_roi.setCheckable(True)
        self.btn_roi.toggled.connect(self._on_roi_toggled)
        self.btn_roi_clear = QPushButton("清除")
        self.btn_roi_clear.clicked.connect(self._clear_roi)
        row.addWidget(self.btn_roi)
        row.addWidget(self.btn_roi_clear)
        f.addRow("分析区", row)
        self.lbl_roi = QLabel("全图")
        f.addRow(self.lbl_roi)
        self.chk_mask = QCheckBox("预览细线掩膜")
        self.chk_mask.setChecked(True)
        self.chk_mask.toggled.connect(self._refresh_mask_overlay)
        f.addRow(self.chk_mask)
        lay.addWidget(gb)

        # --- 刻度 ---
        gb = QGroupBox("刻度(横竖可不同)")
        f = QFormLayout(gb)
        self.spn_sx = QDoubleSpinBox(minimum=1e-6, maximum=1e6, decimals=6,
                                     value=1.0, singleStep=0.1)
        self.spn_sy = QDoubleSpinBox(minimum=1e-6, maximum=1e6, decimals=6,
                                     value=1.0, singleStep=0.1)
        self.edt_unit = QLineEdit("µm")
        self.spn_sx.valueChanged.connect(self._refresh_results)
        self.spn_sy.valueChanged.connect(self._refresh_results)
        self.edt_unit.textChanged.connect(self._refresh_results)
        f.addRow("横向/像素", self.spn_sx)
        f.addRow("纵向/像素", self.spn_sy)
        f.addRow("单位", self.edt_unit)
        lay.addWidget(gb)

        # --- 分析状态 ---
        gb = QGroupBox("分析状态")
        v = QVBoxLayout(gb)
        self.lbl_sig = QLabel("参数签名: —")
        self.lbl_marks = QLabel("标记: —")
        self.lbl_marks.setWordWrap(True)
        self.btn_clear_invalid = QPushButton("清除失效标记")
        self.btn_clear_invalid.clicked.connect(self._clear_invalid)
        self.btn_clear_invalid.setVisible(False)
        v.addWidget(self.lbl_sig)
        v.addWidget(self.lbl_marks)
        v.addWidget(self.btn_clear_invalid)
        lay.addWidget(gb)

        # --- 样图理论值 ---
        self.gb_expected = QGroupBox("样图理论值(供手算核对)")
        v = QVBoxLayout(self.gb_expected)
        self.lbl_expected = QLabel()
        self.lbl_expected.setWordWrap(True)
        v.addWidget(self.lbl_expected)
        self.gb_expected.setVisible(False)
        lay.addWidget(self.gb_expected)

        # --- 路径列表 ---
        gb = QGroupBox("测量路径(点击行高亮)")
        v = QVBoxLayout(gb)
        self.tbl = QTableWidget(0, 5)
        self.tbl.setHorizontalHeaderLabels(["编号", "类型", "像素长", "实际长", "备注"])
        self.tbl.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.tbl.setSelectionMode(QAbstractItemView.SingleSelection)
        self.tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tbl.itemSelectionChanged.connect(self._on_path_selected)
        v.addWidget(self.tbl)
        lay.addWidget(gb)

        # --- 交叉点 ---
        gb = QGroupBox("疑似交叉(度4):指定哪两段相连")
        v = QVBoxLayout(gb)
        self.lst_cross = QListWidget()
        self.lst_cross.itemSelectionChanged.connect(self._on_crossing_selected)
        v.addWidget(self.lst_cross)
        row = QHBoxLayout()
        self.btn_prev_pair = QPushButton("← 上一配对")
        self.btn_next_pair = QPushButton("下一配对 →")
        self.btn_prev_pair.clicked.connect(lambda: self._cycle_pairing(-1))
        self.btn_next_pair.clicked.connect(lambda: self._cycle_pairing(1))
        row.addWidget(self.btn_prev_pair)
        row.addWidget(self.btn_next_pair)
        v.addLayout(row)
        lay.addWidget(gb)

        # --- 导出 ---
        gb = QGroupBox("导出")
        v = QVBoxLayout(gb)
        self.btn_export_img = QPushButton("导出标注图 PNG…")
        self.btn_export_img.clicked.connect(self._export_image)
        self.btn_export_csv = QPushButton("导出逐段数据 CSV…")
        self.btn_export_csv.clicked.connect(self._export_csv)
        v.addWidget(self.btn_export_img)
        v.addWidget(self.btn_export_csv)
        lay.addWidget(gb)
        lay.addStretch(1)

    def _build_menus(self):
        m_file = self.menuBar().addMenu("文件")
        act = QAction("打开图像…", self)
        act.triggered.connect(self._open_image)
        m_file.addAction(act)
        m_file.addSeparator()
        act = QAction("退出", self)
        act.triggered.connect(self.close)
        m_file.addAction(act)

        m_sample = self.menuBar().addMenu("样图")
        for key, title in [("lines", "直线组(水平/斜线/折弯)"),
                           ("loop", "闭环(圆)"),
                           ("crossing", "交叉与分叉")]:
            act = QAction(title, self)
            act.triggered.connect(lambda _=False, k=key: self._load_sample(k))
            m_sample.addAction(act)
        m_sample.addSeparator()
        act = QAction("保存样图到目录…", self)
        act.triggered.connect(self._save_samples)
        m_sample.addAction(act)

    # ================= 图像加载 =================
    def _open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图像", "", "图像 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp);;所有文件 (*)")
        if not path:
            return
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            QMessageBox.warning(self, "打开失败", f"无法读取:{path}")
            return
        self._set_image(bgr, image_id=path, sample_meta=None)

    def _load_sample(self, key):
        img, meta = samples.SAMPLES[key]()
        self._set_image(img, image_id=f"sample:{key}", sample_meta=meta)
        self.spn_sx.setValue(meta["scale_um_per_px"])
        self.spn_sy.setValue(meta["scale_um_per_px"])
        self.edt_unit.setText("µm")

    def _save_samples(self):
        d = QFileDialog.getExistingDirectory(self, "选择保存样图的目录")
        if not d:
            return
        written = samples.save_samples(d)
        self.statusBar().showMessage(f"已保存 {len(written)} 个文件到 {d}")

    def _set_image(self, bgr, image_id, sample_meta):
        self._bgr = bgr
        self._gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        self._image_id = image_id
        self._sample_meta = sample_meta
        self._markings = {}
        self._invalid_markings = []
        self._selected_path_id = None

        binary = is_binary_image(self._gray)
        self._params = MaskParams(binary_input=binary)
        if binary:
            # 前景自动取少数派(纤维通常占小头),"取反"复选框仍可手动覆盖
            n_dark = int((self._gray == self._gray.min()).sum())
            self._params.dark_object = n_dark * 2 <= self._gray.size
            self.chk_dark.setChecked(self._params.dark_object)
        if sample_meta and sample_meta.get("roi"):
            self._params.roi = tuple(sample_meta["roi"])
        else:
            self._params.roi = None
        self.spn_min.setValue(self._params.min_size)

        # 控件状态:二值输入只禁用阈值,取反仍可用
        for w in (self.sld_thr, self.spn_thr):
            w.setEnabled(not binary)
        self.chk_dark.setEnabled(True)
        kind = "二值掩膜(阈值不生效)" if binary else "灰度图"
        self.lbl_input_type.setText(f"输入类型:{kind} · {self._gray.shape[1]}×{self._gray.shape[0]}")

        # 样图理论值
        if sample_meta:
            lines = [f"建议刻度 {sample_meta['scale_um_per_px']} µm/px", ""]
            for e in sample_meta["expected"]:
                real = e["px"] * sample_meta["scale_um_per_px"]
                lines.append(f"· {e['label']}: {e['px']:.2f} px = {real:.2f} µm")
            lines.append("")
            lines.append(sample_meta["note"])
            self.lbl_expected.setText("\n".join(lines))
            self.gb_expected.setVisible(True)
        else:
            self.gb_expected.setVisible(False)

        self.view.set_image(bgr_to_qimage(self._bgr))
        self._update_roi_label()
        self._reanalyze()
        self.statusBar().showMessage(f"已加载:{image_id}")

    # ================= 参数与分析 =================
    def _params_changed(self, *_):
        self._debounce.start()  # 参数变化 → 延迟重算,标记有效性随签名更新

    def _collect_params(self):
        self._params.threshold = self.sld_thr.value()
        self._params.dark_object = self.chk_dark.isChecked()
        self._params.min_size = self.spn_min.value()
        return self._params

    def _reanalyze(self):
        if self._gray is None:
            return
        p = self._collect_params()
        self._mask = make_mask(self._gray, p)
        skel = skeletonize(self._mask)
        self._graph = build_graph(skel)

        # 旧标记按位置匹配到新交叉点;匹配不上 → 失效
        new_markings, invalid = {}, []
        crossings = self._graph.crossings()
        used = set()
        for (pos, idx) in self._marking_positions():
            best, best_d = None, MARK_MATCH_TOL
            for n in crossings:
                if n.id in used:
                    continue
                d = math.hypot(n.center[0] - pos[0], n.center[1] - pos[1])
                if d < best_d:
                    best, best_d = n, d
            if best is not None:
                new_markings[best.id] = idx
                used.add(best.id)
            else:
                invalid.append((pos, idx))
        self._markings = new_markings
        self._invalid_markings = invalid

        self._rebuild_paths()
        self._refresh_mask_overlay()
        self._refresh_status_labels()

    def _marking_positions(self):
        """当前标记对应的 (位置, 配对序号),用于跨参数匹配。"""
        if self._graph is None:
            return []
        out = []
        for nid, idx in self._markings.items():
            n = self._graph.nodes.get(nid)
            if n is not None:
                out.append((n.center, idx))
        return out

    def _rebuild_paths(self):
        self._paths = build_paths(self._graph, self._markings)
        if self._selected_path_id is not None and \
                self._selected_path_id >= len(self._paths):
            self._selected_path_id = None
        self._refresh_results()
        self._refresh_crossing_list()
        self.view.set_overlays(self._graph, self._paths, self._selected_path_id)

    def _refresh_status_labels(self):
        sig = self._params.signature(self._image_id)
        self.lbl_sig.setText(f"参数签名: #{sig}")
        n_valid = len(self._markings)
        n_invalid = len(self._invalid_markings)
        if n_valid == 0 and n_invalid == 0:
            self.lbl_marks.setText("标记: 无(在下方交叉列表中指定配对)")
            self.lbl_marks.setStyleSheet("")
        elif n_invalid == 0:
            self.lbl_marks.setText(f"标记: {n_valid} 条,适用于当前参数 ✓")
            self.lbl_marks.setStyleSheet("color: green")
        else:
            self.lbl_marks.setText(
                f"标记: {n_valid} 条有效 / {n_invalid} 条已失效"
                "(参数已改变,原位置的交叉点不存在)")
            self.lbl_marks.setStyleSheet("color: red")
        self.btn_clear_invalid.setVisible(n_invalid > 0)

    def _refresh_mask_overlay(self):
        if self._mask is None:
            return
        self.view.set_mask_overlay(
            mask_to_qimage(self._mask) if self.chk_mask.isChecked() else None)

    # ================= ROI =================
    def _on_roi_toggled(self, on):
        self.view.set_mode(ImageView.MODE_ROI if on else ImageView.MODE_PAN)

    def _on_roi_selected(self, rect):
        self.btn_roi.setChecked(False)
        x, y, w, h = rect
        self._params.roi = (int(x), int(y), int(w), int(h))
        self._update_roi_label()
        self._reanalyze()

    def _clear_roi(self):
        self._params.roi = None
        self._update_roi_label()
        self._reanalyze()

    def _update_roi_label(self):
        roi = self._params.roi
        self.lbl_roi.setText("全图" if roi is None
                             else f"x={roi[0]} y={roi[1]} w={roi[2]} h={roi[3]}")
        self.view.set_roi_rect(roi)

    # ================= 结果显示 =================
    def _refresh_results(self, *_):
        """路径表格(刻度变化时无需重算图)。"""
        sx, sy, unit = self.spn_sx.value(), self.spn_sy.value(), self.edt_unit.text()
        self.tbl.blockSignals(True)
        self.tbl.setRowCount(len(self._paths))
        for i, p in enumerate(self._paths):
            lp = path_length(p.points)
            lr = path_length(p.points, sx, sy)
            kind = "闭环" if p.kind == "closed" else "开放"
            note = ""
            if p.via_crossings:
                note = "穿过交叉 " + ",".join(f"#{c}" for c in p.via_crossings)
            if p.loop_id is not None:
                note = "无端点闭环"
            vals = (f"P{i}", kind, f"{lp:.2f}", f"{lr:.3f} {unit}", note)
            for j, v in enumerate(vals):
                it = QTableWidgetItem(v)
                if j == 0:
                    it.setBackground(QColor(PATH_COLORS[i % len(PATH_COLORS)]))
                self.tbl.setItem(i, j, it)
        self.tbl.blockSignals(False)
        if self._selected_path_id is not None and self._selected_path_id < len(self._paths):
            self.tbl.selectRow(self._selected_path_id)

    def _on_path_selected(self):
        rows = self.tbl.selectionModel().selectedRows()
        self._selected_path_id = rows[0].row() if rows else None
        self.view.highlight_path(self._selected_path_id)

    # ================= 交叉点配对 =================
    def _refresh_crossing_list(self):
        self.lst_cross.blockSignals(True)
        self.lst_cross.clear()
        if self._graph is not None:
            for n in self._graph.crossings():
                n_opts = len(pairing_options(self._graph, n.id))
                idx = self._markings.get(n.id, 0)
                it = QListWidgetItem(
                    f"交叉 #{n.id} @ ({n.center[0]:.0f},{n.center[1]:.0f}) "
                    f"配对 {idx + 1}/{n_opts}")
                it.setData(Qt.UserRole, n.id)
                self.lst_cross.addItem(it)
        self.lst_cross.blockSignals(False)

    def _selected_crossing_id(self):
        it = self.lst_cross.currentItem()
        return it.data(Qt.UserRole) if it else None

    def _on_crossing_selected(self):
        pass  # 选中即可,配对按钮生效

    def _on_crossing_clicked(self, nid):
        for i in range(self.lst_cross.count()):
            if self.lst_cross.item(i).data(Qt.UserRole) == nid:
                self.lst_cross.setCurrentRow(i)
                break

    def _cycle_pairing(self, delta):
        nid = self._selected_crossing_id()
        if nid is None or self._graph is None:
            self.statusBar().showMessage("先在列表或图上选中一个交叉点")
            return
        n_opts = len(pairing_options(self._graph, nid))
        if n_opts == 0:
            return
        idx = (self._markings.get(nid, 0) + delta) % n_opts
        self._markings[nid] = idx
        # 改一处 → 路径、列表、图上高亮一起更新
        self._rebuild_paths()
        self._refresh_status_labels()
        self.statusBar().showMessage(f"交叉 #{nid} 切换到配对 {idx + 1}/{n_opts}")

    def _clear_invalid(self):
        self._invalid_markings = []
        self._refresh_status_labels()

    # ================= 导出 =================
    def _render_annotated(self) -> np.ndarray:
        img = self._bgr.copy()
        sx, sy, unit = self.spn_sx.value(), self.spn_sy.value(), self.edt_unit.text()
        # 路径
        for p in self._paths:
            c = QColor(PATH_COLORS[p.id % len(PATH_COLORS)])
            color = (c.blue(), c.green(), c.red())
            pts = np.array(p.points, np.int32).reshape(-1, 1, 2)
            cv2.polylines(img, [pts], p.kind == "closed", color, 2, cv2.LINE_AA)
            mx, my = p.points[len(p.points) // 2]
            cv2.putText(img, f"P{p.id}", (int(mx) + 4, int(my) - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        # 节点
        for n in self._graph.nodes.values():
            cx, cy = int(n.center[0]), int(n.center[1])
            if n.kind == "endpoint":
                cv2.circle(img, (cx, cy), 4, (0, 200, 0), -1, cv2.LINE_AA)
            elif n.kind == "branch":
                cv2.rectangle(img, (cx - 4, cy - 4), (cx + 4, cy + 4), (255, 0, 0), -1)
            else:
                cv2.drawMarker(img, (cx, cy), (0, 0, 255), cv2.MARKER_TRIANGLE_UP, 10, 2)
        # ROI
        if self._params.roi:
            x, y, w, h = self._params.roi
            cv2.rectangle(img, (x, y), (x + w, y + h), (0, 215, 255), 1)
        # 比例尺:取图宽 1/5 附近的整齐实际长度,画在右下角(避开原图自带的左下标尺)
        W = img.shape[1]
        nice = self._nice_length(W / 5 * sx)
        bar_px = int(round(nice / sx))
        bx, by = W - bar_px - 20, img.shape[0] - 25
        cv2.line(img, (bx, by), (bx + bar_px, by), (0, 0, 0), 6)
        cv2.line(img, (bx, by), (bx + bar_px, by), (255, 255, 255), 2)
        cv2.putText(img, f"{nice:g} {unit}", (bx, by - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3)
        cv2.putText(img, f"{nice:g} {unit}", (bx, by - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        return img

    @staticmethod
    def _nice_length(target: float) -> float:
        if target <= 0:
            return 1.0
        exp = math.floor(math.log10(target))
        for m in (1, 2, 5, 10):
            v = m * 10 ** exp
            if v >= target * 0.9:
                return v
        return 10 ** (exp + 1)

    def _export_image(self):
        if self._bgr is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出标注图", "annotated.png",
                                              "PNG (*.png);;TIFF (*.tif)")
        if not path:
            return
        cv2.imwrite(path, self._render_annotated())
        self.statusBar().showMessage(f"标注图已导出:{path}")

    def _export_csv(self):
        if not self._paths:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出逐段数据", "measurements.csv",
                                              "CSV (*.csv)")
        if not path:
            return
        sx, sy, unit = self.spn_sx.value(), self.spn_sy.value(), self.edt_unit.text()
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["path_id", "类型", "像素长", "实际长", "单位",
                        "刻度x", "刻度y", "顶点数", "途经交叉", "折线点(x,y)"])
            for p in self._paths:
                pts = ";".join(f"{x:.1f},{y:.1f}" for x, y in p.points)
                w.writerow([f"P{p.id}", "闭环" if p.kind == "closed" else "开放",
                            f"{path_length(p.points):.3f}",
                            f"{path_length(p.points, sx, sy):.4f}", unit,
                            sx, sy, len(p.points),
                            "|".join(f"#{c}" for c in p.via_crossings), pts])
        self.statusBar().showMessage(f"数据已导出:{path}")
