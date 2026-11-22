"""全景换朝向工具 (PySide6).

功能:
  - 调整偏航/俯仰/侧倾, 右侧实时显示重定向后的整张 2:1 平铺图, 左侧为原图对照
  - 点击结果图可放大查看输出像素来自原图哪里
  - 在原图上点击放置地标, 地标随重定向一起映射到结果图
  - 接缝视图: 把首尾两列附近的一段平铺展开并排看
  - 导出 2:1 PNG, 同时保留朝向设置(PNG 文本元数据 + .pose.json)

注意: 每次参数变化都用原图重新取样, 不做累积重采样.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PySide6.QtCore import QPointF, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication, QDialog, QDoubleSpinBox, QFileDialog, QHBoxLayout, QLabel,
    QListWidget, QMainWindow, QMessageBox, QPushButton, QSlider, QSplitter,
    QVBoxLayout, QWidget,
)

from pano_core import (forward_map_points, lonlat_to_uv,
                       output_pixel_to_source, reorient)
from sample_pano import make_sample

MARKER_COLORS = [
    (255, 80, 80), (80, 200, 255), (255, 220, 80), (160, 255, 120),
    (255, 130, 255), (255, 170, 60), (120, 160, 255), (120, 255, 220),
]


def np_to_qimage(arr):
    arr = np.ascontiguousarray(arr)
    h, w = arr.shape[:2]
    return QImage(arr.data, w, h, 3 * w, QImage.Format_RGB888).copy()


def draw_markers(pixmap, markers):
    """markers: (u, v, color, label) 序列, 画圆点+十字+编号."""
    qp = QPainter(pixmap)
    for u, v, color, label in markers:
        qp.setPen(QPen(QColor(*color), 2))
        c = QPointF(u, v)
        qp.drawEllipse(c, 7, 7)
        qp.drawLine(QPointF(u - 11, v), QPointF(u + 11, v))
        qp.drawLine(QPointF(u, v - 11), QPointF(u, v + 11))
        qp.drawText(QPointF(u + 10, v - 10), label)
    qp.end()


class ImageView(QLabel):
    """显示一帧全景图, 点击时以图像像素坐标发出 img_clicked."""

    img_clicked = Signal(float, float)

    def __init__(self, title):
        super().__init__(title)
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(360, 180)
        self.setStyleSheet("background: #202020; color: #888;")
        self._pix = None

    def set_frame(self, arr, markers=()):
        pix = QPixmap.fromImage(np_to_qimage(arr))
        if markers:
            draw_markers(pix, markers)
        self._pix = pix
        self._refresh()

    def _refresh(self):
        if self._pix is None:
            return
        scaled = self._pix.scaled(self.size(), Qt.KeepAspectRatio,
                                  Qt.SmoothTransformation)
        super().setPixmap(scaled)

    def resizeEvent(self, ev):
        self._refresh()
        super().resizeEvent(ev)

    def mousePressEvent(self, ev):
        if self._pix is not None and ev.button() == Qt.LeftButton:
            pm = self.pixmap()
            if not pm.isNull():
                ox = (self.width() - pm.width()) / 2.0
                oy = (self.height() - pm.height()) / 2.0
                sx = self._pix.width() / pm.width()
                x = (ev.position().x() - ox) * sx
                y = (ev.position().y() - oy) * sx
                if 0 <= x < self._pix.width() and 0 <= y < self._pix.height():
                    self.img_clicked.emit(x, y)
        super().mousePressEvent(ev)


class AngleRow(QWidget):
    """一个角度滑杆 + 数值框."""

    changed = Signal()

    def __init__(self, name, lo, hi):
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(QLabel(name))
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(int(lo * 10), int(hi * 10))
        self.spin = QDoubleSpinBox()
        self.spin.setRange(lo, hi)
        self.spin.setSingleStep(1.0)
        self.spin.setDecimals(1)
        self.spin.setSuffix("°")
        lay.addWidget(self.slider, 1)
        lay.addWidget(self.spin)
        self.slider.valueChanged.connect(
            lambda v: self.spin.setValue(v / 10.0))
        self.spin.valueChanged.connect(
            lambda v: (self.slider.setValue(int(round(v * 10))), self.changed.emit()))

    def value(self):
        return self.spin.value()

    def set_value(self, v):
        self.spin.setValue(v)


class InspectDialog(QDialog):
    """放大显示输出图一小块及其在原图中的取样来源."""

    def __init__(self, parent, src, result, angles, x, y):
        super().__init__(parent)
        self.setWindowTitle("像素来源查看")
        yaw, pitch, roll = angles
        H, W = src.shape[:2]
        oh, ow = result.shape[:2]
        u, v, slon, slat = output_pixel_to_source(
            yaw, pitch, roll, x, y, ow, oh, W, H)

        half, scale = 15, 10
        oxs = np.clip(np.arange(x - half, x + half + 1), 0, ow - 1)
        oys = np.clip(np.arange(y - half, y + half + 1), 0, oh - 1)
        out_patch = result[np.ix_(oys, oxs)]
        cx, cy = int(np.floor(u)), int(np.floor(v))
        sxs = np.arange(cx - half, cx + half + 1) % W   # 横向回绕
        sys_ = np.clip(np.arange(cy - half, cy + half + 1), 0, H - 1)
        src_patch = src[np.ix_(sys_, sxs)]

        def zoom(patch):
            z = np.repeat(np.repeat(patch, scale, 0), scale, 1)
            pix = QPixmap.fromImage(np_to_qimage(z))
            qp = QPainter(pix)
            qp.setPen(QPen(QColor(255, 60, 60), 1))
            c = half * scale + scale // 2
            qp.drawLine(c, 0, c, pix.height() - 1)
            qp.drawLine(0, c, pix.width() - 1, c)
            qp.end()
            return pix

        olon = (x + 0.5) / ow * 360.0 - 180.0
        olat = 90.0 - (y + 0.5) / oh * 180.0
        lay = QVBoxLayout(self)
        row = QHBoxLayout()
        for title, pix in (("输出图局部", zoom(out_patch)),
                           ("原图取样处", zoom(src_patch))):
            col = QVBoxLayout()
            lab = QLabel()
            lab.setPixmap(pix)
            col.addWidget(QLabel(title))
            col.addWidget(lab)
            row.addLayout(col)
        lay.addLayout(row)
        lay.addWidget(QLabel(
            f"输出像素 ({x}, {y})  经度 {olon:+.2f}° 纬度 {olat:+.2f}°\n"
            f"来自原图 ({u:.2f}, {v:.2f})  经度 {slon:+.2f}° 纬度 {slat:+.2f}°"))


class SeamDialog(QDialog):
    """把结果图末尾 N 列与开头 N 列并排展开, 中间红线即接缝."""

    def __init__(self, parent, result, n=None):
        super().__init__(parent)
        self.setWindowTitle("接缝展开视图 (左: 末尾列 | 右: 开头列)")
        h, w = result.shape[:2]
        n = n or max(16, w // 16)
        strip = np.concatenate([result[:, -n:], result[:, :n]], axis=1)
        pix = QPixmap.fromImage(np_to_qimage(strip))
        qp = QPainter(pix)
        qp.setPen(QPen(QColor(255, 0, 0), 1))
        qp.drawLine(n, 0, n, h - 1)
        qp.end()
        pix = pix.scaledToHeight(512, Qt.SmoothTransformation)
        lab = QLabel()
        lab.setPixmap(pix)
        lay = QVBoxLayout(self)
        lay.addWidget(lab)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("全景换朝向工具")
        self.src = make_sample(2048)
        self.result = self.src.copy()
        self.landmarks = []  # {"lon","lat","name","color"}
        self._add_mode = False

        central = QWidget()
        root = QVBoxLayout(central)

        # 按钮行
        btns = QHBoxLayout()
        for text, fn in (("载入图片…", self.load_image),
                         ("生成样图", self.make_sample_image),
                         ("查看接缝", self.show_seam),
                         ("清除地标", self.clear_landmarks),
                         ("导出PNG…", self.export_dialog)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            btns.addWidget(b)
        self.add_btn = QPushButton("添加地标: 关")
        self.add_btn.setCheckable(True)
        self.add_btn.toggled.connect(self.toggle_add_mode)
        btns.addWidget(self.add_btn)
        btns.addStretch(1)
        root.addLayout(btns)

        # 角度行
        angles = QHBoxLayout()
        self.rows = {}
        for key, name, lo, hi in (("yaw", "偏航", -180, 180),
                                  ("pitch", "俯仰", -90, 90),
                                  ("roll", "侧倾", -180, 180)):
            row = AngleRow(name, lo, hi)
            row.changed.connect(self.schedule_recompute)
            self.rows[key] = row
            angles.addWidget(row)
        root.addLayout(angles)

        # 图像区
        split = QSplitter(Qt.Horizontal)
        self.view_src = ImageView("原图")
        self.view_out = ImageView("重定向结果")
        split.addWidget(self.view_src)
        split.addWidget(self.view_out)
        root.addWidget(split, 1)
        self.view_src.img_clicked.connect(self.on_src_clicked)
        self.view_out.img_clicked.connect(self.on_out_clicked)

        # 底部: 地标列表 + 提示
        bottom = QHBoxLayout()
        self.lm_list = QListWidget()
        self.lm_list.setMaximumHeight(90)
        bottom.addWidget(self.lm_list, 1)
        hint = QLabel("原图: 开启“添加地标”后点击放置地标\n"
                      "结果图: 点击任意处放大查看像素来源")
        bottom.addWidget(hint, 1)
        root.addLayout(bottom)

        self.setCentralWidget(central)
        self.resize(1280, 720)

        self._timer = QTimer(self, singleShot=True, timeout=self.recompute)
        self.recompute()

    # ---- 参数与重绘 ----
    def angles(self):
        return (self.rows["yaw"].value(), self.rows["pitch"].value(),
                self.rows["roll"].value())

    def set_angles(self, yaw, pitch, roll):
        self.rows["yaw"].set_value(yaw)
        self.rows["pitch"].set_value(pitch)
        self.rows["roll"].set_value(roll)
        self.recompute()

    def schedule_recompute(self):
        self._timer.start(80)  # 拖动滑杆时去抖

    def recompute(self):
        # 始终从原图 self.src 取样, 不在上一次结果上叠加
        self.result = reorient(self.src, *self.angles())
        self.view_src.set_frame(self.src, self._src_markers())
        self.view_out.set_frame(self.result, self._out_markers())
        y, p, r = self.angles()
        self.statusBar().showMessage(
            f"偏航 {y:+.1f}°  俯仰 {p:+.1f}°  侧倾 {r:+.1f}°")

    def _src_markers(self):
        H, W = self.src.shape[:2]
        out = []
        for lm in self.landmarks:
            u, v = lonlat_to_uv(np.deg2rad(lm["lon"]), np.deg2rad(lm["lat"]), H, W)
            out.append((u, v, lm["color"], lm["name"]))
        return out

    def _out_markers(self):
        H, W = self.result.shape[:2]
        out = []
        for lm in self.landmarks:
            lons, lats = forward_map_points(
                np.array([lm["lon"]]), np.array([lm["lat"]]), *self.angles())
            u, v = lonlat_to_uv(np.deg2rad(lons[0]), np.deg2rad(lats[0]), H, W)
            out.append((u, v, lm["color"], lm["name"]))
        return out

    # ---- 交互 ----
    def toggle_add_mode(self, on):
        self._add_mode = on
        self.add_btn.setText(f"添加地标: {'开' if on else '关'}")

    def on_src_clicked(self, x, y):
        H, W = self.src.shape[:2]
        lon = (x + 0.5) / W * 360.0 - 180.0
        lat = 90.0 - (y + 0.5) / H * 180.0
        if not self._add_mode:
            self.statusBar().showMessage(
                f"原图 ({x:.0f}, {y:.0f})  经度 {lon:+.2f}° 纬度 {lat:+.2f}°")
            return
        n = len(self.landmarks)
        lm = {"lon": lon, "lat": lat, "name": f"P{n + 1}",
              "color": MARKER_COLORS[n % len(MARKER_COLORS)]}
        self.landmarks.append(lm)
        self.lm_list.addItem(
            f"{lm['name']}  经度 {lon:+.2f}° 纬度 {lat:+.2f}°")
        self.recompute()

    def on_out_clicked(self, x, y):
        dlg = InspectDialog(self, self.src, self.result, self.angles(),
                            int(x), int(y))
        dlg.exec()

    def show_seam(self):
        SeamDialog(self, self.result).exec()

    def clear_landmarks(self):
        self.landmarks.clear()
        self.lm_list.clear()
        self.recompute()

    # ---- 载入 / 导出 ----
    def load_array(self, arr):
        self.src = np.ascontiguousarray(arr)
        self.landmarks.clear()
        self.lm_list.clear()
        self.recompute()

    def load_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 2:1 全景图", "", "图片 (*.png *.jpg *.jpeg *.bmp)")
        if not path:
            return
        qimg = QImage(path).convertToFormat(QImage.Format_RGB888)
        if qimg.isNull():
            QMessageBox.warning(self, "载入失败", "无法读取该图片")
            return
        w, h = qimg.width(), qimg.height()
        bpl = qimg.bytesPerLine()
        buf = np.frombuffer(qimg.bits(), dtype=np.uint8, count=h * bpl)
        arr = buf.reshape(h, bpl)[:, :w * 3].reshape(h, w, 3).copy()
        if w != 2 * h:
            QMessageBox.warning(self, "比例不符",
                                f"图片为 {w}×{h}, 不是 2:1, 仍按等距柱状处理")
        self.load_array(arr)

    def make_sample_image(self):
        self.load_array(make_sample(2048))

    def export_to(self, path):
        yaw, pitch, roll = self.angles()
        qimg = np_to_qimage(self.result)
        qimg.setText("pano_yaw", str(yaw))
        qimg.setText("pano_pitch", str(pitch))
        qimg.setText("pano_roll", str(roll))
        if not qimg.save(path, "PNG"):
            raise IOError(f"无法写出 {path}")
        meta = {"yaw": yaw, "pitch": pitch, "roll": roll,
                "width": int(self.result.shape[1]),
                "height": int(self.result.shape[0]),
                "landmarks": self.landmarks}
        Path(path).with_suffix(".pose.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    def export_dialog(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "导出全景图", "reoriented.png", "PNG (*.png)")
        if not path:
            return
        try:
            self.export_to(path)
        except IOError as e:
            QMessageBox.warning(self, "导出失败", str(e))
            return
        self.statusBar().showMessage(f"已导出 {path} (含 .pose.json 朝向设置)")


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
