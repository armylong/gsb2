"""app — 本地色域对照工具 (PySide6 GUI).

用法: python app.py
功能概览见 README.md.
"""

from __future__ import annotations

import os
import sys
import traceback

import numpy as np
from PySide6.QtCore import Qt, QRect, QPoint, Signal
from PySide6.QtGui import QImage, QPainter, QPen, QColor
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QScrollArea, QSplitter,
    QVBoxLayout, QHBoxLayout, QFormLayout, QComboBox, QPushButton,
    QLabel, QCheckBox, QPlainTextEdit, QFileDialog, QMessageBox,
    QGroupBox, QSizePolicy,
)

import gamut_core as gc

METHODS = {
    "逐通道截断 (clip)": "clip",
    "保持色相压缩 (CIELAB LCh)": "hue",
    "不映射 (仅转换+校验)": "none",
}
METHOD_SPACE = {
    "clip": "目标 RGB 空间逐通道截断到 [0,1]",
    "hue": "CIELAB (D65) 中固定 L*/h, 二分压缩 C* 到色域边界",
    "none": "不映射; 超界值保留, 预览仅临时截断显示并以标记遮盖",
}
OVERLAY_MODES = ["无叠加", "色域外标记", "ΔE 热力"]


def np_to_qimage(rgb_u8):
    h, w, _ = rgb_u8.shape
    buf = np.ascontiguousarray(rgb_u8)
    img = QImage(buf.data, w, h, w * 3, QImage.Format_RGB888)
    return img.copy()  # 拷贝, 避免 numpy 缓冲生命周期问题


class ImageCanvas(QWidget):
    """图像显示: 缩放、点击点读、拖拽选区. 坐标均以图像像素为准."""

    pixelPicked = Signal(int, int)
    regionSelected = Signal(int, int, int, int)

    def __init__(self):
        super().__init__()
        self._img = None
        self._zoom = 1.0
        self._fit = True
        self._sel = None          # QRect (图像坐标)
        self._drag_start = None
        self._picked = None       # (x, y)
        self.setMinimumSize(320, 240)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(False)

    def set_image(self, qimg):
        self._img = qimg
        self.update()

    def set_fit(self, fit):
        self._fit = fit
        self.update()

    def set_zoom(self, z):
        self._zoom = z
        self._fit = False
        self.update()

    def clear_selection(self):
        self._sel = None
        self._picked = None
        self.update()

    def _scale(self):
        if self._img is None:
            return 1.0
        if self._fit:
            return min(self.width() / self._img.width(),
                       self.height() / self._img.height())
        return self._zoom

    def _origin(self):
        s = self._scale()
        return QPoint((self.width() - self._img.width() * s) / 2,
                      (self.height() - self._img.height() * s) / 2)

    def _to_image(self, pos):
        o = self._origin()
        s = self._scale()
        return int((pos.x() - o.x()) / s), int((pos.y() - o.y()) / s)

    def paintEvent(self, ev):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(40, 40, 40))
        if self._img is None:
            p.setPen(QColor(180, 180, 180))
            p.drawText(self.rect(), Qt.AlignCenter,
                       "打开 PNG 或生成内置样图\n(预览基准: 目标编码值直接上屏)")
            p.end()
            return
        s = self._scale()
        o = self._origin()
        p.translate(o)
        p.scale(s, s)
        smooth = s < 1.0
        p.setRenderHint(QPainter.SmoothPixmapTransform, smooth)
        p.drawImage(0, 0, self._img)
        p.setRenderHint(QPainter.SmoothPixmapTransform, False)
        if self._sel is not None:
            p.setPen(QPen(QColor(255, 200, 0), 0))
            p.drawRect(self._sel)
        if self._picked is not None:
            x, y = self._picked
            p.setPen(QPen(QColor(0, 255, 255), 0))
            p.drawRect(QRect(x, y, 1, 1))
        p.end()

    def mousePressEvent(self, ev):
        if self._img is None or ev.button() != Qt.LeftButton:
            return
        self._drag_start = ev.position().toPoint()
        self._sel = None

    def mouseMoveEvent(self, ev):
        if self._drag_start is None or self._img is None:
            return
        x0, y0 = self._to_image(self._drag_start)
        x1, y1 = self._to_image(ev.position().toPoint())
        w, h = self._img.width(), self._img.height()
        r = QRect(QPoint(x0, y0), QPoint(x1, y1)).normalized()
        self._sel = r.intersected(QRect(0, 0, w, h))
        self.update()

    def mouseReleaseEvent(self, ev):
        if self._img is None or ev.button() != Qt.LeftButton:
            return
        start, self._drag_start = self._drag_start, None
        if start is None:
            return
        moved = (ev.position().toPoint() - start).manhattanLength()
        x, y = self._to_image(ev.position().toPoint())
        w, h = self._img.width(), self._img.height()
        if moved < 4:  # 点击 = 点读
            if 0 <= x < w and 0 <= y < h:
                self._picked = (x, y)
                self.pixelPicked.emit(x, y)
        else:
            if self._sel is not None and self._sel.width() >= 1 and self._sel.height() >= 1:
                r = self._sel
                self.regionSelected.emit(r.x(), r.y(), r.width(), r.height())
        self.update()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("色域对照工具 (sRGB / Display P3)")
        self.resize(1280, 860)
        self.src_u8 = None
        self.result = None
        self.last_export = None

        # ---- 左侧: 图像 ----
        self.canvas = ImageCanvas()
        self.canvas.pixelPicked.connect(self.on_pick)
        self.canvas.regionSelected.connect(self.on_region)
        scroll = QScrollArea()
        scroll.setWidget(self.canvas)
        scroll.setWidgetResizable(True)

        # ---- 右侧: 控制 ----
        right = QWidget()
        v = QVBoxLayout(right)

        # 图像来源
        grp_src = QGroupBox("图像")
        f = QFormLayout(grp_src)
        self.sample_combo = QComboBox()
        self.sample_combo.addItems(list(gc.SAMPLES.keys()))
        btn_sample = QPushButton("生成内置样图")
        btn_sample.clicked.connect(self.on_sample)
        btn_open = QPushButton("打开 PNG…")
        btn_open.clicked.connect(self.on_open)
        row = QHBoxLayout()
        row.addWidget(self.sample_combo)
        row.addWidget(btn_sample)
        f.addRow(row)
        f.addRow(btn_open)
        self.lbl_image = QLabel("未载入图像")
        self.lbl_image.setWordWrap(True)
        f.addRow(self.lbl_image)
        v.addWidget(grp_src)

        # 色域与映射
        grp_g = QGroupBox("色域与映射")
        f = QFormLayout(grp_g)
        self.src_combo = QComboBox()
        self.tgt_combo = QComboBox()
        for g in gc.GAMUTS.values():
            self.src_combo.addItem(g.label, g.key)
            self.tgt_combo.addItem(g.label, g.key)
        self.src_combo.setCurrentIndex(1)   # 默认 P3 -> sRGB (相册输出场景)
        self.tgt_combo.setCurrentIndex(0)
        self.method_combo = QComboBox()
        for label, key in METHODS.items():
            self.method_combo.addItem(label, key)
        self.method_combo.setCurrentIndex(1)
        self.overlay_combo = QComboBox()
        self.overlay_combo.addItems(OVERLAY_MODES)
        self.overlay_combo.setCurrentIndex(1)
        self.zoom_combo = QComboBox()
        self.zoom_combo.addItems(["适配窗口", "50%", "100%", "200%", "400%", "800%"])
        for w in (self.src_combo, self.tgt_combo, self.method_combo, self.overlay_combo):
            w.currentIndexChanged.connect(self.recompute)
        self.zoom_combo.currentIndexChanged.connect(self.on_zoom)
        f.addRow("来源色域", self.src_combo)
        f.addRow("目标色域", self.tgt_combo)
        f.addRow("映射方式", self.method_combo)
        f.addRow("叠加显示", self.overlay_combo)
        f.addRow("缩放", self.zoom_combo)
        v.addWidget(grp_g)

        # 转换信息
        self.lbl_conv = QLabel()
        self.lbl_conv.setWordWrap(True)
        self.lbl_conv.setStyleSheet("QLabel { background: #2b2b2b; color: #ddd; padding: 6px; }")
        v.addWidget(self.lbl_conv)

        # 点读
        grp_pick = QGroupBox("点读 (单击图像)")
        self.lbl_pick = QPlainTextEdit()
        self.lbl_pick.setReadOnly(True)
        self.lbl_pick.setMaximumBlockCount(100)
        self.lbl_pick.setFixedHeight(150)
        pv = QVBoxLayout(grp_pick)
        pv.addWidget(self.lbl_pick)
        v.addWidget(grp_pick)

        # 选区统计
        grp_stat = QGroupBox("选区统计 (拖拽框选, 按实际像素计算)")
        self.lbl_stat = QPlainTextEdit()
        self.lbl_stat.setReadOnly(True)
        self.lbl_stat.setFixedHeight(170)
        sv = QVBoxLayout(grp_stat)
        sv.addWidget(self.lbl_stat)
        v.addWidget(grp_stat)

        # 导出 / 验证
        row = QHBoxLayout()
        btn_export = QPushButton("导出 PNG (带目标色域说明)…")
        btn_export.clicked.connect(self.on_export)
        btn_verify = QPushButton("重新载入验证导出")
        btn_verify.clicked.connect(self.on_verify)
        row.addWidget(btn_export)
        row.addWidget(btn_verify)
        v.addLayout(row)

        # 日志
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setFixedHeight(140)
        v.addWidget(self.log)
        v.addStretch(1)

        right.setFixedWidth(460)
        split = QSplitter()
        split.addWidget(scroll)
        split.addWidget(right)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 0)
        self.setCentralWidget(split)

        self.on_sample()  # 启动即生成样图, 立即可用

    # ------------------------------------------------------------------
    def log_msg(self, msg):
        self.log.appendPlainText(msg)

    def cur_src(self):
        return gc.GAMUTS[self.src_combo.currentData()]

    def cur_tgt(self):
        return gc.GAMUTS[self.tgt_combo.currentData()]

    def cur_method(self):
        return self.method_combo.currentData()

    # ------------------------------------------------------------------
    def on_sample(self):
        name = self.sample_combo.currentText()
        self.src_u8 = gc.SAMPLES[name]()
        self.lbl_image.setText(f"内置样图: {name}  {self.src_u8.shape[1]}x{self.src_u8.shape[0]}"
                               " (编码值按所选来源色域解释)")
        self.canvas.clear_selection()
        self.recompute()

    def on_open(self):
        path, _ = QFileDialog.getOpenFileName(self, "打开 PNG", "", "PNG 图像 (*.png)")
        if not path:
            return
        try:
            png = gc.read_png(path)
        except gc.PNGError as e:
            QMessageBox.warning(self, "无法载入", f"无法载入 PNG:\n{e}")
            self.log_msg(f"载入失败: {e}")
            return
        self.src_u8 = png["rgb"]
        desc = png["icc_desc"] or ("sRGB 块" if png["has_srgb"] else "无内嵌色域标记")
        self.lbl_image.setText(
            f"{os.path.basename(path)}  {png['width']}x{png['height']}\n"
            f"文件色域标记: {desc} (来源色域仍以左侧选择为准)")
        if png["note"]:
            self.log_msg(f"载入注意: {png['note']}")
        self.log_msg(f"已载入 {path} ({png['width']}x{png['height']})")
        self.canvas.clear_selection()
        self.recompute()

    # ------------------------------------------------------------------
    def recompute(self):
        if self.src_u8 is None:
            return
        src, tgt, method = self.cur_src(), self.cur_tgt(), self.cur_method()
        try:
            self.result = gc.pipeline(self.src_u8, src, tgt, method)
        except Exception:
            self.log_msg("计算出错:\n" + traceback.format_exc())
            return
        oog_n = int(self.result["oog"].sum())
        total = self.result["oog"].size
        self.lbl_conv.setText(
            f"转换路径: {src.label} → XYZ(D65) → {tgt.label}\n"
            f"映射: {METHOD_SPACE[method]}\n"
            f"色域外像素: {oog_n} / {total} ({100.0 * oog_n / total:.2f}%)\n"
            f"预览基准: 目标编码值直接上屏 (Qt 按 sRGB 解释); 外部屏幕能力未知,\n"
            f"请以点读数值与色域外标记为准 — 截断/压缩处已用标记遮盖, 不伪装成原色")
        self.update_preview()
        self.canvas.clear_selection()
        self.lbl_stat.setPlainText("(拖拽框选后显示统计)")
        self.lbl_pick.setPlainText("(单击图像显示点读)")

    def update_preview(self):
        r = self.result
        disp = r["mapped_u8"].astype(np.float64)
        mode = self.overlay_combo.currentText()
        oog = r["oog"]
        if mode == "色域外标记" and oog.any():
            # 品红 + 棋盘纹, 明确遮盖被截断/压缩处
            yy, xx = np.mgrid[0:disp.shape[0], 0:disp.shape[1]]
            checker = ((xx // 4 + yy // 4) % 2).astype(np.float64)[..., None]
            mark = np.array([1.0, 0.0, 1.0]) * 255 * (0.55 + 0.45 * checker)
            disp = np.where(oog[..., None], mark, disp)
        elif mode == "ΔE 热力":
            d = np.clip(r["deltaE"] / 20.0, 0, 1)[..., None]  # 20 ΔE 饱和
            heat = np.concatenate([d, np.zeros_like(d), (1 - d)], axis=-1) * 255
            disp = heat
        self.canvas.set_image(np_to_qimage(disp.astype(np.uint8)))

    def on_zoom(self):
        t = self.zoom_combo.currentText()
        if t == "适配窗口":
            self.canvas.set_fit(True)
        else:
            self.canvas.set_zoom(float(t.rstrip("%")) / 100.0)

    # ------------------------------------------------------------------
    def on_pick(self, x, y):
        r = self.result
        if r is None:
            return
        src, tgt = self.cur_src(), self.cur_tgt()
        s8 = r["src_u8"][y, x]
        slin = r["src_lin"][y, x]
        ideal = r["tgt_ideal"][y, x]
        m8 = r["mapped_u8"][y, x]
        oog = bool(r["oog"][y, x])
        de = r["deltaE"][y, x]
        self.lbl_pick.setPlainText(
            f"坐标: ({x}, {y})\n"
            f"输入 ({src.key} 编码): R={s8[0]} G={s8[1]} B={s8[2]}\n"
            f"输入 (线性): {slin[0]:.4f} {slin[1]:.4f} {slin[2]:.4f}\n"
            f"目标理想值 ({tgt.key} 线性): {ideal[0]:.4f} {ideal[1]:.4f} {ideal[2]:.4f}\n"
            f"目标输出 ({tgt.key} 编码): R={m8[0]} G={m8[1]} B={m8[2]}\n"
            f"色域判定: {'色域外 — 已被映射, 非原色' if oog else '色域内 — 可精确表示'}\n"
            f"ΔE76 (CIELAB): {de:.3f}")

    def on_region(self, x, y, w, h):
        r = self.result
        if r is None:
            return
        sl = (slice(y, y + h), slice(x, x + w))
        oog = r["oog"][sl]
        de = r["deltaE"][sl]
        n = oog.size
        n_oog = int(oog.sum())
        de_in = de[~oog]
        src_reg = r["src_u8"][sl].reshape(-1, 3)
        tgt_reg = r["mapped_u8"][sl].reshape(-1, 3)
        lines = [
            f"选区: ({x},{y}) {w}x{h} = {n} 像素 (按实际像素统计)",
            f"色域外: {n_oog} ({100.0 * n_oog / n:.2f}%)",
            f"ΔE76: 均值 {de.mean():.3f}  最大 {de.max():.3f}",
        ]
        if de_in.size:
            lines.append(f"色域内像素 ΔE 最大 {de_in.max():.4f} "
                         f"({'未变, 与源一致' if de_in.max() < 0.01 else '有变化!'})")
        lines.append("输入编码  R[{0},{1}] G[{2},{3}] B[{4},{5}]".format(
            src_reg[:, 0].min(), src_reg[:, 0].max(),
            src_reg[:, 1].min(), src_reg[:, 1].max(),
            src_reg[:, 2].min(), src_reg[:, 2].max()))
        lines.append("输出编码  R[{0},{1}] G[{2},{3}] B[{4},{5}]".format(
            tgt_reg[:, 0].min(), tgt_reg[:, 0].max(),
            tgt_reg[:, 1].min(), tgt_reg[:, 1].max(),
            tgt_reg[:, 2].min(), tgt_reg[:, 2].max()))
        if n_oog:
            lines.append("注意: 选区含色域外像素, 输出值是映射结果, 不是原色")
        self.lbl_stat.setPlainText("\n".join(lines))

    # ------------------------------------------------------------------
    def on_export(self):
        r = self.result
        if r is None:
            QMessageBox.information(self, "无图像", "请先载入图像或生成样图")
            return
        tgt, method = self.cur_tgt(), self.cur_method()
        oog_n = int(r["oog"].sum())
        # 不能写入的情形: 未映射但存在色域外像素 — 直接写入只能截断, 会伪装成原色
        if method == "none" and oog_n:
            QMessageBox.warning(
                self, "目标不能写入",
                f"当前为'不映射'模式, 且图像含 {oog_n} 个目标色域外像素.\n"
                f"这些像素的理想值超出 {tgt.label} 可表达范围, 无法原样编码;\n"
                f"强行写入只能静默截断, 会把截断色伪装成原色.\n"
                f"请改用'逐通道截断'或'保持色相压缩'后再导出.")
            self.log_msg(f"导出被拒绝: 不映射模式下存在 {oog_n} 个色域外像素, 目标无法原样写入")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出 PNG", f"export_{tgt.key}.png", "PNG 图像 (*.png)")
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        try:
            gc.write_png(path, r["mapped_u8"], tgt,
                         {"Mapping": dict((v, k) for k, v in METHODS.items())[method],
                          "Source Gamut": self.cur_src().label})
        except OSError as e:
            QMessageBox.warning(self, "写入失败", f"目标位置不能写入:\n{e}")
            self.log_msg(f"导出失败: {e}")
            return
        self.last_export = (path, r["mapped_u8"].copy(), tgt)
        self.log_msg(f"已导出 {path} (目标 {tgt.label}, {oog_n} 个像素经映射)")

    def on_verify(self):
        if self.last_export is not None:
            path, expected, tgt = self.last_export
        else:
            path, _ = QFileDialog.getOpenFileName(self, "选择要验证的 PNG", "",
                                                  "PNG 图像 (*.png)")
            if not path:
                return
            expected, tgt = None, self.cur_tgt()
        ok, report = gc.verify_export(path, expected, tgt)
        self.log_msg(report)
        if not ok:
            QMessageBox.warning(self, "验证未通过", report)


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
