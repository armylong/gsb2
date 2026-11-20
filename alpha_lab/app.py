"""PySide6 图形界面: 透明 PNG 混合像素检查窗口。

布局: 左侧控制面板 + 右侧 2x3 视图网格 (缩放/平移联动, 悬停显示像素数值)。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QPainter, QPen, QColor
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QSplitter,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from . import core, samples, selftest

EXPLANATION = """\
<h3>为什么会有"脏边"?</h3>
<p>直通 (straight) PNG 里, <b>A=0 的像素仍然带着 RGB 数据</b>。
导出工具常把这些区域填成白或黑。查看器缩放、压缩或误按预乘处理时,
这些杂色被插值进半透明边缘 —— 白残留叠深色底就是一圈亮脏边。</p>

<h3>两种透明度存储约定</h3>
<ul>
<li><b>直通 / 非预乘</b>: RGB 存纯颜色, A 存覆盖度。PNG 的标准。</li>
<li><b>预乘</b>: RGB 已乘过 A。合成公式简化为 <code>out = fg + bg·(1−a)</code>,
滤波不会引入杂色, 游戏纹理/视频管线常用。</li>
</ul>
<p>切换左侧"数据解读方式", 观察把直通图误当预乘图时颜色与边缘的变化。</p>

<h3>计算空间与中间灰</h3>
<p>50% 覆盖的白叠黑:</p>
<ul>
<li><b>sRGB 空间</b>直接加权 → 0.5 → <b>128</b>/255 (偏暗, 但多数老软件如此)</li>
<li><b>线性光空间</b>加权 → 0.5 线性 ≈ 0.735 sRGB → <b>188</b>/255 (物理正确)</li>
</ul>
<p>两者相差约 60 个灰阶, 全部误差都集中在中间调 —— 看"线性−sRGB 差异"视图。</p>

<h3>用法</h3>
<ul>
<li>滚轮缩放 (≥8x 显示像素网格), 拖拽平移, 六个视图联动</li>
<li>悬停任意视图, 状态栏显示该像素的直通/预乘数值</li>
<li>"前景原始 RGB"视图忽略 α, 可看到 A=0 处隐藏的通道数据</li>
</ul>
"""


def _gray(a: np.ndarray) -> np.ndarray:
    return np.stack([a, a, a], axis=-1)


class ImageView(QWidget):
    """单幅图像视图: 最近邻缩放、平移、像素网格、悬停坐标。"""

    hoverPixel = Signal(int, int)
    viewChanged = Signal(float, float, float)  # zoom, cx, cy

    def __init__(self, title: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.title = title
        self._qimg: QImage | None = None
        self._img_size = (1, 1)
        self.zoom = 1.0
        self.cx = 0.5  # 视图中心对应的归一化图像坐标
        self.cy = 0.5
        self._drag_start = None
        self.setMouseTracking(True)
        self.setMinimumSize(220, 220)

    # ---------------------------------------------------------- 数据与视图
    def set_image(self, rgb: np.ndarray):
        u8 = core.to_u8(rgb)
        h, w, _ = u8.shape
        self._qimg = QImage(u8.data, w, h, w * 3, QImage.Format_RGB888).copy()
        self._img_size = (w, h)
        self.update()

    def set_view(self, zoom: float, cx: float, cy: float):
        self.zoom, self.cx, self.cy = zoom, cx, cy
        self.update()

    def _fit_scale(self) -> float:
        w, h = self._img_size
        return min(self.width() / w, self.height() / h)

    def _to_image(self, px: float, py: float) -> tuple[float, float]:
        scale = self._fit_scale() * self.zoom
        w, h = self._img_size
        ox = self.width() / 2 - self.cx * w * scale
        oy = self.height() / 2 - self.cy * h * scale
        return (px - ox) / scale, (py - oy) / scale

    # ---------------------------------------------------------- 绘制
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(32, 32, 34))
        if self._qimg is not None:
            scale = self._fit_scale() * self.zoom
            w, h = self._img_size
            ox = self.width() / 2 - self.cx * w * scale
            oy = self.height() / 2 - self.cy * h * scale
            p.translate(ox, oy)
            p.scale(scale, scale)
            p.setRenderHint(QPainter.SmoothPixmapTransform, False)  # 最近邻
            p.drawImage(0, 0, self._qimg)
            if scale >= 8:  # 像素网格
                p.setPen(QPen(QColor(255, 255, 255, 40), 0))
                for x in range(w + 1):
                    p.drawLine(x, 0, x, h)
                for y in range(h + 1):
                    p.drawLine(0, y, w, y)
            p.resetTransform()
        p.setPen(QColor(230, 230, 230))
        p.drawText(8, 18, f"{self.title}   [{self.zoom:.1f}x]")
        p.end()

    # ---------------------------------------------------------- 交互
    def wheelEvent(self, event):
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.zoom = float(np.clip(self.zoom * factor, 0.25, 64.0))
        self.viewChanged.emit(self.zoom, self.cx, self.cy)
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._drag_start = (event.position(), self.cx, self.cy)

    def mouseMoveEvent(self, event):
        pos = event.position()
        if self._drag_start and event.buttons() & Qt.LeftButton:
            start, cx0, cy0 = self._drag_start
            scale = self._fit_scale() * self.zoom
            w, h = self._img_size
            self.cx = cx0 - (pos.x() - start.x()) / (w * scale)
            self.cy = cy0 - (pos.y() - start.y()) / (h * scale)
            self.viewChanged.emit(self.zoom, self.cx, self.cy)
            self.update()
        ix, iy = self._to_image(pos.x(), pos.y())
        w, h = self._img_size
        if 0 <= ix < w and 0 <= iy < h:
            self.hoverPixel.emit(int(ix), int(iy))

    def mouseReleaseEvent(self, event):
        self._drag_start = None


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("alpha_lab — 透明 PNG 混合像素检查")
        self.resize(1280, 820)

        self.fg_rgb, self.fg_a = samples.make_foreground(256, "white")
        self.bg = samples.make_background(256)
        self.checker = samples.make_checker(256)
        self._syncing = False

        self._build_ui()
        self.rebuild()

    # ---------------------------------------------------------- UI
    def _build_ui(self):
        panel = QVBoxLayout()
        panel.addWidget(QLabel("<b>样例 / 文件</b>"))

        self.combo_pollution = QComboBox()
        for mode in samples.POLLUTION_MODES:
            self.combo_pollution.addItem(samples.POLLUTION_LABELS[mode], mode)
        self.combo_pollution.setCurrentIndex(1)
        self.combo_pollution.currentIndexChanged.connect(self._regen_sample)
        panel.addWidget(self.combo_pollution)

        for text, slot in [
            ("重新生成样例", self._regen_sample),
            ("导入透明 PNG…", self._import_png),
            ("导出合成结果…", self._export_composite),
            ("运行数值自检", self._run_selftest),
        ]:
            btn = QPushButton(text)
            btn.clicked.connect(slot)
            panel.addWidget(btn)

        panel.addWidget(QLabel("<b>数据解读方式</b>"))
        self.radio_straight = QRadioButton("直通 (straight, PNG 标准)")
        self.radio_premult = QRadioButton("预乘 (premultiplied)")
        self.radio_straight.setChecked(True)
        self.radio_straight.toggled.connect(self.rebuild)
        panel.addWidget(self.radio_straight)
        panel.addWidget(self.radio_premult)

        panel.addWidget(QLabel("<b>导出用的合成空间</b>"))
        self.combo_space = QComboBox()
        self.combo_space.addItem("sRGB 空间 (传统)", "srgb")
        self.combo_space.addItem("线性光空间 (物理正确)", "linear")
        panel.addWidget(self.combo_space)

        panel.addWidget(QLabel("<b>缩放</b>"))
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(25, 6400)  # 0.25x .. 64x (x100)
        self.slider.setValue(100)
        self.slider.valueChanged.connect(self._slider_zoom)
        panel.addWidget(self.slider)

        help_box = QTextBrowser()
        help_box.setHtml(EXPLANATION)
        help_box.setOpenExternalLinks(False)
        panel.addWidget(help_box, stretch=1)

        side = QWidget()
        side.setLayout(panel)
        side.setMinimumWidth(300)
        side.setMaximumWidth(380)

        self.views: list[ImageView] = []
        titles = [
            "前景原始 RGB (忽略 α)",
            "覆盖度 α",
            "合成 · sRGB 空间",
            "合成 · 线性光空间",
            "线性−sRGB 差异 ×4",
            "棋盘底预览",
        ]
        grid = QGridLayout()
        for i, t in enumerate(titles):
            v = ImageView(t)
            v.hoverPixel.connect(self._on_hover)
            v.viewChanged.connect(self._on_view_changed)
            grid.addWidget(v, i // 3, i % 3)
            self.views.append(v)
        views_w = QWidget()
        views_w.setLayout(grid)

        split = QSplitter()
        split.addWidget(side)
        split.addWidget(views_w)
        split.setStretchFactor(1, 1)
        self.setCentralWidget(split)
        self.statusBar().showMessage("就绪")

    # ---------------------------------------------------------- 数据流
    def _current_color_alpha(self) -> tuple[np.ndarray, np.ndarray]:
        """按当前解读方式返回 (直通颜色, 覆盖度)。"""
        if self.radio_premult.isChecked():
            # 把现有数据当作预乘解读: 颜色 = RGB / A
            return core.premult_to_straight(self.fg_rgb, self.fg_a), self.fg_a
        return self.fg_rgb, self.fg_a

    def rebuild(self):
        color, a = self._current_color_alpha()
        comp_srgb = core.composite_straight(color, a, self.bg, space="srgb")
        comp_lin = core.composite_straight(color, a, self.bg, space="linear")
        diff = np.clip(np.abs(comp_lin - comp_srgb) * 4.0, 0.0, 1.0)
        on_checker = core.composite_straight(color, a, self.checker, space="srgb")
        for view, img in zip(
            self.views, [color, _gray(a), comp_srgb, comp_lin, diff, on_checker]
        ):
            view.set_image(img)

    def _regen_sample(self):
        mode = self.combo_pollution.currentData()
        self.fg_rgb, self.fg_a = samples.make_foreground(256, mode)
        self.bg = samples.make_background(256)
        self.checker = samples.make_checker(256)
        self.rebuild()
        self.statusBar().showMessage(f"已生成样例: {samples.POLLUTION_LABELS[mode]}")

    # ---------------------------------------------------------- 联动
    def _on_view_changed(self, zoom, cx, cy):
        if self._syncing:
            return
        self._syncing = True
        for v in self.views:
            v.set_view(zoom, cx, cy)
        self.slider.blockSignals(True)
        self.slider.setValue(int(zoom * 100))
        self.slider.blockSignals(False)
        self._syncing = False

    def _slider_zoom(self, value: int):
        self._on_view_changed(value / 100.0, self.views[0].cx, self.views[0].cy)

    def _on_hover(self, x: int, y: int):
        h, w = self.fg_a.shape
        if not (0 <= x < w and 0 <= y < h):
            return
        rgb = self.fg_rgb[y, x]
        a = float(self.fg_a[y, x])
        prem = core.straight_to_premult(rgb[None, None, :], self.fg_a[y, x][None, None])[0, 0]
        self.statusBar().showMessage(
            f"({x},{y})  直通 RGBA=({rgb[0]:.3f},{rgb[1]:.3f},{rgb[2]:.3f},{a:.3f})"
            f"  预乘 RGB=({prem[0]:.3f},{prem[1]:.3f},{prem[2]:.3f})"
            f"  u8=({round(rgb[0]*255)},{round(rgb[1]*255)},{round(rgb[2]*255)},{round(a*255)})"
        )

    # ---------------------------------------------------------- 文件
    def _import_png(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "导入透明 PNG", "", "PNG 图像 (*.png);;所有文件 (*)"
        )
        if not path:
            return
        qimg = QImage(path).convertToFormat(QImage.Format_RGBA8888)
        if qimg.isNull():
            QMessageBox.warning(self, "导入失败", f"无法读取: {path}")
            return
        w, h = qimg.width(), qimg.height()
        ptr = qimg.bits()
        arr = np.frombuffer(ptr, dtype=np.uint8, count=w * h * 4).reshape(h, w, 4)
        f = core.from_u8(arr.copy())
        self.fg_rgb, self.fg_a = f[..., :3], f[..., 3]
        self.bg = self._bg_for(w, h)
        self.checker = samples.make_checker(max(w, h))[:h, :w]
        self.rebuild()
        self.statusBar().showMessage(f"已导入 {path} ({w}x{h})")

    def _bg_for(self, w: int, h: int) -> np.ndarray:
        bg = np.empty((h, w, 3), dtype=np.float32)
        bg[:, : w // 2] = (0.05, 0.06, 0.12)
        bg[:, w // 2 :] = (0.92, 0.90, 0.86)
        return bg

    def _export_composite(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出合成结果", "composite.png", "PNG (*.png)")
        if not path:
            return
        color, a = self._current_color_alpha()
        space = self.combo_space.currentData()
        out = core.composite_straight(color, a, self.bg, space=space)
        u8 = core.to_u8(out)
        h, w, _ = u8.shape
        qimg = QImage(u8.data, w, h, w * 3, QImage.Format_RGB888).copy()
        if qimg.save(path):
            self.statusBar().showMessage(f"已导出 ({space} 空间): {path}")
        else:
            QMessageBox.warning(self, "导出失败", f"无法写入: {path}")

    # ---------------------------------------------------------- 自检
    def _run_selftest(self):
        results = selftest.run_all()
        failed = sum(not ok for _, ok, _ in results)
        lines = [f"{'PASS' if ok else 'FAIL'}  {name}  —  {detail}" for name, ok, detail in results]
        box = QMessageBox(
            QMessageBox.Information if not failed else QMessageBox.Warning,
            "数值自检",
            f"{len(results) - failed}/{len(results)} 项通过\n\n" + "\n".join(lines),
            parent=self,
        )
        box.exec()
