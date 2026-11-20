"""PySide6 图形界面.

功能:
  * 打开照片或一键生成带损伤的合成样例
  * 笔刷涂出待修区域, 可单独查看 原图 / 遮罩 / 叠加 / 当前结果
  * 一键对当前遮罩同时试算 邻域插值 与 纹理式 两种方法, 弹窗并排对比,
    逐块选择更满意的结果提交 (有 ground truth 时显示各自遮罩内误差)
  * 提交历史可撤销 (Ctrl+Z); 修改遮罩只影响未提交的预览
  * 导出修复结果; 合成样例下报告遮罩内误差
"""

from __future__ import annotations

import sys

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QPainter, QPixmap, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton,
    QRadioButton, QSlider, QVBoxLayout, QWidget,
)

from .synth import generate_sample
from .session import RepairSession
from .metrics import mask_errors

VIEW_MODES = ("当前结果", "原始(损伤)图", "遮罩", "遮罩叠加")
METHOD_LABEL = {"diffusion": "邻域插值 (扩散)", "texture": "纹理式 (样本块)"}


def np_to_qimage(img: np.ndarray) -> QImage:
    img = np.ascontiguousarray(img)
    if img.ndim == 2:
        return QImage(img.data, img.shape[1], img.shape[0],
                      img.strides[0], QImage.Format_Grayscale8).copy()
    return QImage(img.data, img.shape[1], img.shape[0],
                  img.strides[0], QImage.Format_RGB888).copy()


class Canvas(QWidget):
    """图像显示 + 遮罩涂抹画布."""
    maskEdited = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(420, 420)
        self._image: np.ndarray | None = None   # 当前显示的合成图
        self._mask: np.ndarray | None = None    # 0/255
        self.brush_radius = 12
        self._drawing = False
        self._erase = False

    # ---- 数据 ----
    def set_display(self, img: np.ndarray, mask: np.ndarray):
        self._image = img
        self._mask = mask
        self.update()

    def set_mask_array(self, mask: np.ndarray):
        self._mask = mask
        self.update()

    # ---- 坐标映射 ----
    def _transform(self):
        if self._image is None:
            return None
        h, w = self._image.shape[:2]
        s = min(self.width() / w, self.height() / h)
        ox = (self.width() - w * s) / 2
        oy = (self.height() - h * s) / 2
        return s, ox, oy

    def _to_image_coords(self, pos):
        t = self._transform()
        if t is None:
            return None
        s, ox, oy = t
        x = int((pos.x() - ox) / s)
        y = int((pos.y() - oy) / s)
        h, w = self._image.shape[:2]
        if 0 <= x < w and 0 <= y < h:
            return x, y
        return None

    # ---- 绘制 ----
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), Qt.darkGray)
        if self._image is None:
            p.setPen(Qt.white)
            p.drawText(self.rect(), Qt.AlignCenter,
                       "点击 [生成样例] 或 [打开图片] 开始")
            return
        t = self._transform()
        s, ox, oy = t
        h, w = self._image.shape[:2]
        qimg = np_to_qimage(self._image)
        p.drawPixmap(int(ox), int(oy), int(w * s), int(h * s), QPixmap.fromImage(qimg))

    # ---- 涂抹 ----
    def mousePressEvent(self, e):
        if self._mask is None:
            return
        if e.button() in (Qt.LeftButton, Qt.RightButton):
            self._drawing = True
            self._erase = e.button() == Qt.RightButton
            self._paint_at(e.position())

    def mouseMoveEvent(self, e):
        if self._drawing:
            self._paint_at(e.position())

    def mouseReleaseEvent(self, e):
        self._drawing = False

    def _paint_at(self, pos):
        xy = self._to_image_coords(pos)
        if xy is None:
            return
        x, y = xy
        r = self.brush_radius
        h, w = self._mask.shape
        yy, xx = np.ogrid[:h, :w]
        region = (xx - x) ** 2 + (yy - y) ** 2 <= r * r
        self._mask[region] = 0 if self._erase else 255
        self.maskEdited()


class CompareDialog(QDialog):
    """两种方法并排对比, 用户逐块选择."""

    def __init__(self, previews: dict, errors: dict | None, parent=None):
        super().__init__(parent)
        self.setWindowTitle("选择本块修补结果")
        self.selected = None
        layout = QHBoxLayout(self)
        self._radios = {}
        for method, img in previews.items():
            col = QVBoxLayout()
            title = METHOD_LABEL[method]
            if errors and method in errors:
                e = errors[method]
                title += f"\n遮罩内 MAE={e['mae']:.2f} RMSE={e['rmse']:.2f}"
            col.addWidget(QLabel(title))
            qimg = np_to_qimage(img)
            pix = QPixmap.fromImage(qimg).scaledToWidth(380, Qt.SmoothTransformation)
            pic = QLabel()
            pic.setPixmap(pix)
            col.addWidget(pic)
            rb = QRadioButton("采用此方法")
            self._radios[method] = rb
            col.addWidget(rb)
            layout.addLayout(col)
        # 默认选误差较小者 / 纹理式
        default = "texture"
        if errors and "diffusion" in errors and "texture" in errors:
            default = min(errors, key=lambda m: errors[m]["rmse"])
        self._radios[default].setChecked(True)
        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def accept(self):
        for m, rb in self._radios.items():
            if rb.isChecked():
                self.selected = m
        super().accept()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("老照片划痕修补")
        self.damaged: np.ndarray | None = None   # 原始(损伤)图
        self.clean: np.ndarray | None = None     # 合成样例的 ground truth
        self.line_mask: np.ndarray | None = None
        self.session: RepairSession | None = None
        self.mask: np.ndarray | None = None
        self.eval_mask: np.ndarray | None = None  # 已提交遮罩的并集
        self._pending: dict = {}                  # 未提交的预览 {method: img}

        self.canvas = Canvas()
        self.canvas.maskEdited.connect(self._on_mask_edited)

        # ---- 右侧控制面板 ----
        panel = QVBoxLayout()
        self.btn_sample = QPushButton("生成样例")
        self.btn_open = QPushButton("打开图片…")
        self.btn_export = QPushButton("导出结果…")
        self.btn_sample.clicked.connect(self.make_sample)
        self.btn_open.clicked.connect(self.open_image)
        self.btn_export.clicked.connect(self.export_result)
        panel.addWidget(self.btn_sample)
        panel.addWidget(self.btn_open)
        panel.addWidget(self.btn_export)

        panel.addWidget(QLabel("查看:"))
        self.view_combo = QComboBox()
        self.view_combo.addItems(VIEW_MODES)
        self.view_combo.currentIndexChanged.connect(self._refresh)
        panel.addWidget(self.view_combo)

        panel.addWidget(QLabel("笔刷大小 (左键涂 / 右键擦):"))
        self.brush = QSlider(Qt.Horizontal, minimum=3, maximum=60, value=12)
        self.brush.valueChanged.connect(lambda v: setattr(self.canvas, "brush_radius", v))
        panel.addWidget(self.brush)

        self.btn_clear_mask = QPushButton("清除当前遮罩")
        self.btn_clear_mask.clicked.connect(self.clear_mask)
        panel.addWidget(self.btn_clear_mask)

        self.btn_compare = QPushButton("对比两种方法 (当前遮罩)")
        self.btn_compare.clicked.connect(self.compare_methods)
        panel.addWidget(self.btn_compare)

        self.btn_undo = QPushButton("撤销上一次提交")
        self.btn_undo.clicked.connect(self.undo)
        panel.addWidget(self.btn_undo)
        QShortcut(QKeySequence.Undo, self, activated=self.undo)

        panel.addStretch(1)
        side = QWidget()
        side.setLayout(panel)
        side.setFixedWidth(240)

        root = QHBoxLayout()
        root.addWidget(self.canvas, stretch=1)
        root.addWidget(side)
        central = QWidget()
        central.setLayout(root)
        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

    # ---------- 数据装载 ----------
    def _load(self, damaged, clean=None, line_mask=None):
        self.damaged = damaged
        self.clean = clean
        self.line_mask = line_mask
        self.session = RepairSession(damaged)
        self.mask = np.zeros(damaged.shape[:2], np.uint8)
        self.eval_mask = np.zeros_like(self.mask)
        self._pending = {}
        self._refresh()
        self.statusBar().showMessage(
            f"已装载 {damaged.shape[1]}x{damaged.shape[0]}" +
            (" (含 ground truth)" if clean is not None else ""))

    def make_sample(self):
        s = generate_sample()
        self._load(s["damaged"], clean=s["clean"], line_mask=s["line_mask"])

    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图片", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        qimg = QImage(path).convertToFormat(QImage.Format_RGB888)
        w, h = qimg.width(), qimg.height()
        ptr = qimg.bits()
        arr = np.frombuffer(ptr, np.uint8).reshape(h, w, 3).copy()
        self._load(arr)

    # ---------- 显示 ----------
    def _compose(self) -> np.ndarray | None:
        if self.session is None:
            return None
        mode = self.view_combo.currentText()
        if mode == "原始(损伤)图":
            return self.damaged
        if mode == "遮罩":
            return np.stack([self.mask] * 3, axis=-1)
        if mode == "遮罩叠加":
            out = self.session.result.copy()
            out[self.mask > 0] = (0.4 * out[self.mask > 0] + 0.6 * np.array([255, 40, 40])).astype(np.uint8)
            return out
        return self.session.result  # 当前结果

    def _refresh(self):
        img = self._compose()
        if img is not None:
            self.canvas.set_display(img, self.mask)

    # ---------- 遮罩 ----------
    def _on_mask_edited(self):
        # 遮罩变化只影响未提交预览: 丢弃旧预览, 已提交结果不动
        if self._pending:
            self._pending = {}
            self.statusBar().showMessage("遮罩已修改, 之前的对比预览已失效 (已提交结果不受影响)")
        self._refresh()

    def clear_mask(self):
        if self.mask is not None:
            self.mask[:] = 0
            self._pending = {}
            self._refresh()

    # ---------- 修补 ----------
    def compare_methods(self):
        if self.session is None:
            return
        if not (self.mask > 0).any():
            QMessageBox.information(self, "提示", "请先用笔刷涂出待修区域")
            return
        self.statusBar().showMessage("正在试算两种方法… (纹理式可能需要几秒)")
        QApplication.processEvents()
        self._pending = {
            m: self.session.preview(self.mask, m) for m in ("diffusion", "texture")
        }
        errors = None
        if self.clean is not None:
            errors = {m: mask_errors(img, self.clean, self.mask)
                      for m, img in self._pending.items()}
        dlg = CompareDialog(self._pending, errors, self)
        if dlg.exec() and dlg.selected:
            self.session.commit(self.mask, dlg.selected)
            self.eval_mask[self.mask > 0] = 255
            self.mask[:] = 0
            self._pending = {}
            self._report(dlg.selected)
        self._refresh()

    def undo(self):
        if self.session and self.session.undo():
            # 撤销后评估遮罩难以精确回退, 直接清空重新累计
            self.eval_mask[:] = 0
            self._pending = {}
            self._refresh()
            self.statusBar().showMessage(f"已撤销, 剩余历史 {self.session.depth} 步")
        else:
            self.statusBar().showMessage("没有可撤销的提交")

    def _report(self, method):
        msg = f"已提交 [{METHOD_LABEL[method]}], 历史 {self.session.depth} 步"
        if self.clean is not None and (self.eval_mask > 0).any():
            e = mask_errors(self.session.result, self.clean, self.eval_mask)
            msg += f" | 已修区域 vs 原图: MAE={e['mae']:.2f} RMSE={e['rmse']:.2f}"
        self.statusBar().showMessage(msg)

    # ---------- 导出 ----------
    def export_result(self):
        if self.session is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出修复结果", "repaired.png",
                                              "PNG (*.png);;JPEG (*.jpg)")
        if not path:
            return
        qimg = np_to_qimage(self.session.result)
        qimg.save(path)
        msg = f"已导出 {path}"
        if self.clean is not None and (self.eval_mask > 0).any():
            e = mask_errors(self.session.result, self.clean, self.eval_mask)
            msg += f" | 遮罩内误差 MAE={e['mae']:.2f} RMSE={e['rmse']:.2f}"
        self.statusBar().showMessage(msg)


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.resize(1000, 640)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
