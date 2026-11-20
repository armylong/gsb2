"""PySide6 图形界面。

布局: 左 = 原稿视图, 中 = 当前结果视图, 右 = 控制面板。
所有处理都从原始灰度图重新计算, 切换角度/参数不会累积误差。
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import Qt, QRectF, QPointF, Signal
from PySide6.QtGui import QImage, QPainter, QPen, QColor, QPixmap, QPolygonF
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton, QRadioButton,
    QScrollArea, QSlider, QSpinBox, QSplitter, QVBoxLayout, QWidget, QTextEdit,
)

from ..core import PipelineParams, estimate_skew, process
from ..core.geometry import STATUS_OK, map_points

MAX_LONG_SIDE = 1800


# ---------------------------------------------------------------- 图像视图

class ImageView(QWidget):
    """按比例显示图像, 支持叠加多边形/矩形, 可框选 ROI (发出图像坐标矩形)。"""

    roi_selected = Signal(QRectF)

    def __init__(self, title="", parent=None):
        super().__init__(parent)
        self._qimg: QImage | None = None
        self._overlays: list[dict] = []
        self._select_enabled = False
        self._sel_start: QPointF | None = None
        self._sel_cur: QPointF | None = None
        self._title = title
        self.setMinimumSize(280, 360)
        self.setMouseTracking(False)

    def set_image(self, qimg: QImage | None):
        self._qimg = qimg
        self.update()

    def set_overlays(self, overlays: list[dict]):
        self._overlays = overlays
        self.update()

    def enable_selection(self, on: bool):
        self._select_enabled = on
        self.setCursor(Qt.CrossCursor if on else Qt.ArrowCursor)

    def _view_transform(self):
        """返回 (scale, offset_x, offset_y) 图像->视图。"""
        if self._qimg is None:
            return 1.0, 0.0, 0.0
        iw, ih = self._qimg.width(), self._qimg.height()
        s = min(self.width() / iw, self.height() / ih)
        s = min(s, 1.0)
        ox = (self.width() - iw * s) / 2
        oy = (self.height() - ih * s) / 2
        return s, ox, oy

    def _to_image(self, pos: QPointF) -> QPointF:
        s, ox, oy = self._view_transform()
        return QPointF((pos.x() - ox) / s, (pos.y() - oy) / s)

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(48, 48, 48))
        if self._qimg is None:
            p.setPen(QColor(200, 200, 200))
            p.drawText(self.rect(), Qt.AlignCenter, self._title or "无图像")
            p.end()
            return
        s, ox, oy = self._view_transform()
        p.setRenderHint(QPainter.SmoothPixmapTransform)
        p.drawImage(QRectF(ox, oy, self._qimg.width() * s, self._qimg.height() * s),
                    self._qimg)
        for ov in self._overlays:
            pen = QPen(QColor(*ov.get("color", (255, 80, 80))))
            pen.setWidth(2)
            if ov.get("dashed"):
                pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            pts = [QPointF(x * s + ox, y * s + oy) for x, y in ov["points"]]
            if ov.get("closed", True):
                p.drawPolygon(QPolygonF(pts))
            else:
                p.drawPolyline(QPolygonF(pts))
            if ov.get("label") and pts:
                p.drawText(pts[0] + QPointF(4, -4), ov["label"])
        if self._sel_start and self._sel_cur:
            p.setPen(QPen(QColor(80, 200, 255), 1, Qt.DashLine))
            p.drawRect(QRectF(self._sel_start, self._sel_cur).normalized())
        p.end()

    def mousePressEvent(self, e):
        if self._select_enabled and self._qimg is not None and e.button() == Qt.LeftButton:
            self._sel_start = self._sel_cur = e.position()
            self.update()

    def mouseMoveEvent(self, e):
        if self._sel_start is not None:
            self._sel_cur = e.position()
            self.update()

    def mouseReleaseEvent(self, e):
        if self._sel_start is not None and e.button() == Qt.LeftButton:
            rect_v = QRectF(self._sel_start, e.position()).normalized()
            self._sel_start = self._sel_cur = None
            self.update()
            if rect_v.width() > 4 and rect_v.height() > 4:
                s, ox, oy = self._view_transform()
                rect_i = QRectF((rect_v.left() - ox) / s, (rect_v.top() - oy) / s,
                                rect_v.width() / s, rect_v.height() / s)
                img_rect = QRectF(0, 0, self._qimg.width(), self._qimg.height())
                rect_i = rect_i.intersected(img_rect)
                if not rect_i.isEmpty():
                    self.roi_selected.emit(rect_i)


# ---------------------------------------------------------------- 直方图

class HistogramWidget(QWidget):
    """处理前后两条亮度直方图 (灰=处理前, 蓝=处理后)。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._before: np.ndarray | None = None
        self._after: np.ndarray | None = None
        self.setMinimumHeight(90)

    def set_data(self, before, after):
        self._before = before
        self._after = after
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 30))
        w, h = self.width(), self.height()
        for data, color in ((self._before, QColor(170, 170, 170)),
                            (self._after, QColor(90, 160, 255))):
            if data is None or len(data) == 0:
                continue
            hist, _ = np.histogram(data, bins=64, range=(0, 256))
            peak = hist.max() or 1
            pts = [QPointF(i / 63 * w, h - 4 - (v / peak) * (h - 12))
                   for i, v in enumerate(hist)]
            p.setPen(QPen(color, 1))
            p.drawPolyline(QPolygonF(pts))
        p.setPen(QColor(120, 120, 120))
        p.drawText(4, 12, "灰=处理前 蓝=处理后")
        p.end()


# ---------------------------------------------------------------- 工具函数

def gray_to_qimage(arr: np.ndarray) -> QImage:
    a = np.ascontiguousarray(arr)
    img = QImage(a.data, a.shape[1], a.shape[0], a.strides[0],
                 QImage.Format_Grayscale8)
    return img.copy()


def color_to_qimage(bgr: np.ndarray) -> QImage:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    a = np.ascontiguousarray(rgb)
    img = QImage(a.data, a.shape[1], a.shape[0], a.strides[0], QImage.Format_RGB888)
    return img.copy()


def rect_to_poly(rect: QRectF):
    return [(rect.left(), rect.top()), (rect.right(), rect.top()),
            (rect.right(), rect.bottom()), (rect.left(), rect.bottom())]


def samples_in_poly(img: np.ndarray, poly: np.ndarray,
                    valid_mask: np.ndarray | None = None) -> np.ndarray:
    """取多边形区域内的像素样本 (可选与有效区域掩膜求交)。"""
    h, w = img.shape
    m = np.zeros((h, w), np.uint8)
    cv2.fillPoly(m, [np.round(poly).astype(np.int32)], 255)
    if valid_mask is not None:
        m = cv2.bitwise_and(m, valid_mask)
    return img[m > 0]


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("扫描件倾斜与照明校正")
        self.resize(1440, 900)

        self.src_path: Path | None = None
        self.src_color: np.ndarray | None = None   # 显示用
        self.src_gray: np.ndarray | None = None    # 处理用
        self.auto_estimate = None                  # SkewEstimate
        self.result = None                         # PipelineResult
        self.rois: dict[str, QRectF | None] = {"paper": None, "line": None}
        self._roi_mode: str | None = None

        self._build_ui()
        self._update_info()

    # ---------------- UI 搭建 ----------------
    def _build_ui(self):
        self.view_src = ImageView("原稿")
        self.view_dst = ImageView("当前结果")
        self.view_src.roi_selected.connect(self._on_roi_selected)

        panel = self._build_panel()
        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(340)

        split = QSplitter()
        split.addWidget(self.view_src)
        split.addWidget(self.view_dst)
        split.addWidget(scroll)
        split.setSizes([520, 520, 360])
        self.setCentralWidget(split)
        self.statusBar().showMessage("请打开 PNG/JPEG 图像, 或生成合成样例")

    def _build_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        btn_open = QPushButton("打开图像…")
        btn_open.clicked.connect(self._open_image)
        btn_gen = QPushButton("生成合成样例并载入")
        btn_gen.clicked.connect(self._gen_samples)
        lay.addWidget(btn_open)
        lay.addWidget(btn_gen)

        # --- 倾斜 ---
        g = QGroupBox("倾斜校正")
        v = QVBoxLayout(g)
        self.lbl_angle = QLabel("尚未估计")
        self.lbl_angle.setWordWrap(True)
        v.addWidget(self.lbl_angle)
        row = QHBoxLayout()
        self.btn_auto = QPushButton("自动估计")
        self.btn_auto.clicked.connect(self._auto_angle)
        self.btn_restore = QPushButton("恢复自动值")
        self.btn_restore.clicked.connect(self._restore_auto)
        self.btn_restore.setEnabled(False)
        row.addWidget(self.btn_auto)
        row.addWidget(self.btn_restore)
        v.addLayout(row)
        row = QHBoxLayout()
        row.addWidget(QLabel("校正角 (°):"))
        self.spin_angle = QDoubleSpinBox()
        self.spin_angle.setRange(-10.0, 10.0)
        self.spin_angle.setSingleStep(0.05)
        self.spin_angle.setDecimals(2)
        self.spin_angle.valueChanged.connect(self._recompute)
        row.addWidget(self.spin_angle)
        self.chk_deskew = QCheckBox("启用")
        self.chk_deskew.setChecked(True)
        self.chk_deskew.toggled.connect(self._recompute)
        row.addWidget(self.chk_deskew)
        v.addLayout(row)
        lay.addWidget(g)

        # --- 照明 ---
        g = QGroupBox("照明均衡")
        v = QVBoxLayout(g)
        row = QHBoxLayout()
        self.chk_illum = QCheckBox("启用")
        self.chk_illum.setChecked(True)
        self.chk_illum.toggled.connect(self._recompute)
        row.addWidget(self.chk_illum)
        row.addWidget(QLabel("强度"))
        self.sld_illum = QSlider(Qt.Horizontal)
        self.sld_illum.setRange(0, 100)
        self.sld_illum.setValue(100)
        self.sld_illum.valueChanged.connect(self._recompute)
        row.addWidget(self.sld_illum)
        v.addLayout(row)
        lay.addWidget(g)

        # --- 输出 ---
        g = QGroupBox("输出")
        v = QVBoxLayout(g)
        row = QHBoxLayout()
        self.rb_gray = QRadioButton("灰度")
        self.rb_gray.setChecked(True)
        self.rb_bin = QRadioButton("二值")
        self.rb_gray.toggled.connect(self._recompute)
        row.addWidget(self.rb_gray)
        row.addWidget(self.rb_bin)
        v.addLayout(row)
        row = QHBoxLayout()
        row.addWidget(QLabel("邻域"))
        self.spin_block = QSpinBox()
        self.spin_block.setRange(3, 151)
        self.spin_block.setSingleStep(2)
        self.spin_block.setValue(35)
        self.spin_block.valueChanged.connect(self._recompute)
        row.addWidget(self.spin_block)
        row.addWidget(QLabel("C"))
        self.spin_c = QSpinBox()
        self.spin_c.setRange(0, 40)
        self.spin_c.setValue(10)
        self.spin_c.valueChanged.connect(self._recompute)
        row.addWidget(self.spin_c)
        v.addLayout(row)
        lay.addWidget(g)

        # --- 选区 ---
        g = QGroupBox("选区 (在原稿视图上框选)")
        v = QVBoxLayout(g)
        row = QHBoxLayout()
        self.btn_roi_paper = QPushButton("框选纸白区域")
        self.btn_roi_paper.setCheckable(True)
        self.btn_roi_paper.toggled.connect(lambda on: self._set_roi_mode("paper", on))
        self.btn_roi_line = QPushButton("框选细线区域")
        self.btn_roi_line.setCheckable(True)
        self.btn_roi_line.toggled.connect(lambda on: self._set_roi_mode("line", on))
        btn_clear = QPushButton("清除选区")
        btn_clear.clicked.connect(self._clear_rois)
        row.addWidget(self.btn_roi_paper)
        row.addWidget(self.btn_roi_line)
        row.addWidget(btn_clear)
        v.addLayout(row)
        self.hist = HistogramWidget()
        v.addWidget(self.hist)
        self.txt_roi = QTextEdit()
        self.txt_roi.setReadOnly(True)
        self.txt_roi.setMaximumHeight(120)
        v.addWidget(self.txt_roi)
        lay.addWidget(g)

        # --- 导出 ---
        g = QGroupBox("导出")
        v = QVBoxLayout(g)
        self.lbl_out = QLabel("—")
        self.lbl_out.setWordWrap(True)
        v.addWidget(self.lbl_out)
        btn_export = QPushButton("导出 PNG + 参数记录…")
        btn_export.clicked.connect(self._export)
        v.addWidget(btn_export)
        lay.addWidget(g)

        lay.addStretch(1)
        return w

    # ---------------- 图像载入 ----------------
    def _load_file(self, path: Path):
        data = np.fromfile(str(path), dtype=np.uint8)
        color = cv2.imdecode(data, cv2.IMREAD_COLOR)
        if color is None:
            QMessageBox.warning(self, "无法读取", f"不支持的文件: {path.name}")
            return
        h, w = color.shape[:2]
        if max(h, w) > MAX_LONG_SIDE:
            QMessageBox.warning(self, "尺寸超限",
                                f"长边 {max(h, w)} 像素, 超过 {MAX_LONG_SIDE} 上限")
            return
        self.src_path = path
        self.src_color = color
        self.src_gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
        self.rois = {"paper": None, "line": None}
        self.view_src.set_image(color_to_qimage(color))
        self.statusBar().showMessage(f"已载入 {path.name} ({w}×{h})")
        self._auto_angle()          # 载入后自动估计一次

    def _open_image(self):
        fn, _ = QFileDialog.getOpenFileName(
            self, "打开扫描图像", "", "图像 (*.png *.jpg *.jpeg)")
        if fn:
            self._load_file(Path(fn))

    def _gen_samples(self):
        from ..samples.generator import generate_samples
        out = Path("samples_generated")
        generate_samples(out)
        self.statusBar().showMessage(f"样例已生成到 {out}/")
        self._load_file(out / "text_tilt_m7.png")

    # ---------------- 倾角 ----------------
    def _auto_angle(self):
        if self.src_gray is None:
            return
        self.auto_estimate = estimate_skew(self.src_gray)
        est = self.auto_estimate
        direction = "逆时针" if est.angle > 0 else ("顺时针" if est.angle < 0 else "—")
        self.lbl_angle.setText(
            f"角度 {est.angle:+.2f}° ({direction}) | 置信度 {est.confidence:.2f}\n"
            f"状态: {est.message}")
        if est.status == STATUS_OK:
            self.spin_angle.blockSignals(True)
            self.spin_angle.setValue(est.angle)
            self.spin_angle.blockSignals(False)
            self.btn_restore.setEnabled(True)
        else:
            self.spin_angle.blockSignals(True)
            self.spin_angle.setValue(0.0)
            self.spin_angle.blockSignals(False)
            self.btn_restore.setEnabled(False)
            self.statusBar().showMessage(f"注意: {est.message}")
        self._recompute()

    def _restore_auto(self):
        if self.auto_estimate is not None and self.auto_estimate.status == STATUS_OK:
            self.spin_angle.setValue(self.auto_estimate.angle)

    # ---------------- 处理 ----------------
    def _params(self) -> PipelineParams:
        return PipelineParams(
            angle=self.spin_angle.value(),
            deskew=self.chk_deskew.isChecked(),
            illumination=self.chk_illum.isChecked(),
            illum_strength=self.sld_illum.value() / 100.0,
            mode="binary" if self.rb_bin.isChecked() else "gray",
            bin_block=self.spin_block.value(),
            bin_c=self.spin_c.value(),
        )

    def _recompute(self):
        if self.src_gray is None:
            return
        self.result = process(self.src_gray, self._params())
        self.view_dst.set_image(gray_to_qimage(self.result.image))
        self._update_info()
        self._update_overlays()
        self._update_roi_stats()

    def _update_info(self):
        if self.result is None:
            self.lbl_out.setText("—")
            return
        r = self.result
        h, w = r.image.shape
        frac = (r.mask > 0).mean()
        p = self._params()
        self.lbl_out.setText(
            f"输出尺寸 {w}×{h} | 填充灰度 {r.fill_value} (纸白)\n"
            f"有效区域 {frac * 100:.1f}% | 模式 {'二值' if p.mode == 'binary' else '灰度'}"
        )

    # ---------------- 选区 ----------------
    def _set_roi_mode(self, kind, on):
        if on:
            other = self.btn_roi_line if kind == "paper" else self.btn_roi_paper
            other.blockSignals(True)
            other.setChecked(False)
            other.blockSignals(False)
            self._roi_mode = kind
            self.view_src.enable_selection(True)
            self.statusBar().showMessage(
                f"请在原稿视图上拖拽框选{'纸白' if kind == 'paper' else '细线'}区域")
        else:
            self._roi_mode = None
            self.view_src.enable_selection(False)

    def _on_roi_selected(self, rect: QRectF):
        if self._roi_mode is None:
            return
        self.rois[self._roi_mode] = rect
        btn = self.btn_roi_paper if self._roi_mode == "paper" else self.btn_roi_line
        btn.blockSignals(True)
        btn.setChecked(False)
        btn.blockSignals(False)
        self._roi_mode = None
        self.view_src.enable_selection(False)
        self._update_overlays()
        self._update_roi_stats()

    def _clear_rois(self):
        self.rois = {"paper": None, "line": None}
        self._update_overlays()
        self._update_roi_stats()

    def _update_overlays(self):
        src_ov, dst_ov = [], []
        # 结果视图: 有效边界
        if self.result is not None:
            h, w = self.src_gray.shape
            corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], float)
            mapped = map_points(self.result.matrix, corners)
            dst_ov.append({"points": mapped.tolist(), "color": (255, 170, 40),
                           "label": "有效边界"})
        for kind, color, label in (("paper", (80, 220, 120), "纸白"),
                                   ("line", (80, 160, 255), "细线")):
            rect = self.rois.get(kind)
            if rect is None:
                continue
            poly = rect_to_poly(rect)
            src_ov.append({"points": poly, "color": color, "label": label})
            if self.result is not None:
                mapped = map_points(self.result.matrix, np.array(poly, float))
                dst_ov.append({"points": mapped.tolist(), "color": color,
                               "label": label, "dashed": True})
        self.view_src.set_overlays(src_ov)
        self.view_dst.set_overlays(dst_ov)

    def _update_roi_stats(self):
        if self.src_gray is None or self.result is None:
            self.txt_roi.clear()
            self.hist.set_data(None, None)
            return
        lines = []
        hist_before = hist_after = None
        for kind, name in (("paper", "纸白"), ("line", "细线")):
            rect = self.rois.get(kind)
            if rect is None:
                continue
            x0, y0 = int(rect.left()), int(rect.top())
            x1, y1 = int(rect.right()) + 1, int(rect.bottom()) + 1
            before = self.src_gray[y0:y1, x0:x1].ravel()
            poly = map_points(self.result.matrix,
                              np.array(rect_to_poly(rect), float))
            # 纸白统计排除旋转填充区; 细线区域同样求交以免混入填充
            after = samples_in_poly(self.result.image, poly, self.result.mask)
            if after.size == 0:
                lines.append(f"[{name}] 映射区域完全落在填充区外, 无有效样本")
                continue
            lines.append(
                f"[{name}] 处理前 均值{before.mean():6.1f} 标准差{before.std():5.1f} "
                f"范围[{before.min()},{before.max()}]\n"
                f"　　 处理后 均值{after.mean():6.1f} 标准差{after.std():5.1f} "
                f"范围[{after.min()},{after.max()}] (n={after.size})")
            if hist_before is None:
                hist_before, hist_after = before, after
        self.txt_roi.setPlainText("\n".join(lines) if lines else "尚未框选区域")
        self.hist.set_data(hist_before, hist_after)

    # ---------------- 导出 ----------------
    def _export(self):
        if self.result is None or self.src_path is None:
            QMessageBox.information(self, "无结果", "请先载入图像")
            return
        default = str(self.src_path.with_name(self.src_path.stem + "_corrected.png"))
        fn, _ = QFileDialog.getSaveFileName(self, "导出 PNG", default, "PNG (*.png)")
        if not fn:
            return
        out = Path(fn)
        if out.resolve() == self.src_path.resolve():
            QMessageBox.warning(self, "不允许", "不能覆盖原稿, 请换一个文件名")
            return
        ok, buf = cv2.imencode(".png", self.result.image)
        if not ok:
            QMessageBox.warning(self, "失败", "PNG 编码失败")
            return
        out.write_bytes(buf.tobytes())
        p = self._params()
        h, w = self.result.image.shape
        record = {
            "source_file": str(self.src_path),
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "angle_deg": p.angle,
            "deskew_enabled": p.deskew,
            "illumination": {"enabled": p.illumination,
                             "strength": p.illum_strength},
            "output_mode": p.mode,
            "binarize": {"block_size": max(3, p.bin_block | 1), "C": p.bin_c},
            "output_size": [w, h],
            "fill_gray": self.result.fill_value,
            "valid_area_fraction": round(float((self.result.mask > 0).mean()), 4),
        }
        out.with_suffix(".json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        self.statusBar().showMessage(f"已导出 {out.name} 与参数记录 JSON")


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
