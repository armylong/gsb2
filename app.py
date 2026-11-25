"""裸眼立体图 (SIRDS) 生成器 GUI — PySide6。

运行:  python app.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QPixmap, QPainter, QPen, QColor, QFont
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QFormLayout,
    QGroupBox, QLabel, QSpinBox, QDoubleSpinBox, QComboBox, QPushButton,
    QFileDialog, QMessageBox, QScrollArea, QSplitter, QTabWidget, QSizePolicy,
)

from sirds_core import (
    RenderParams, make_depth, render_sirds, analyze_row, validate_params,
    make_default_texture, params_to_dict,
)


# ------------------------------------------------------------ 小工具

def np_to_qimage(arr: np.ndarray) -> QImage:
    """uint8 (h,w,3) RGB 或 (h,w) 灰度 -> QImage (复制数据, 可安全保存)。"""
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    h, w, _ = arr.shape
    buf = np.ascontiguousarray(arr)
    img = QImage(buf.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return img.copy()


def depth_to_gray(depth: np.ndarray) -> np.ndarray:
    """深度 -> 灰度显示图 (亮 = 近)。"""
    return (np.clip(depth, 0, 1) * 255).astype(np.uint8)


def load_gray_png(path: str, w: int, h: int) -> np.ndarray:
    """读入灰度 PNG 作为深度图, 缩放到工作尺寸, 归一化到 [0,1] (亮=近)。"""
    img = QImage(path).convertToFormat(QImage.Format.Format_Grayscale8)
    img = img.scaled(w, h, Qt.AspectRatioMode.IgnoreAspectRatio,
                     Qt.TransformationMode.SmoothTransformation)
    ptr = img.constBits()
    arr = np.frombuffer(ptr, dtype=np.uint8, count=img.sizeInBytes())
    arr = arr[: h * img.bytesPerLine()].reshape(h, img.bytesPerLine())[:, :w]
    return arr.astype(float) / 255.0


def load_texture(path: str) -> np.ndarray:
    img = QImage(path).convertToFormat(QImage.Format.Format_RGB888)
    w, h = img.width(), img.height()
    ptr = img.constBits()
    arr = np.frombuffer(ptr, dtype=np.uint8, count=img.sizeInBytes())
    return arr[: h * img.bytesPerLine()].reshape(h, img.bytesPerLine(), 3)[:, :w, :].copy()


# ------------------------------------------------------------ 行检查器

class RowInspector(QWidget):
    """画出一行的深度、输出像素、同名点连线与被遮挡的候选匹配。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(190)
        self.setSizePolicy(QSizePolicy.Policy.Expanding,
                           QSizePolicy.Policy.Fixed)
        self._depth_row: np.ndarray | None = None
        self._out_row: np.ndarray | None = None
        self._dbg = None

    def set_row(self, depth_row, out_row, dbg):
        self._depth_row = depth_row
        self._out_row = out_row
        self._dbg = dbg
        self.update()

    def summary(self) -> str:
        if self._dbg is None:
            return ""
        dist = self._dbg.pair_distances
        if dist.size == 0:
            return "本行没有同名点对。"
        vals, counts = np.unique(dist, return_counts=True)
        parts = [f"{v}px×{c}" for v, c in zip(vals, counts)]
        return (f"同名点对距离分布: {'  '.join(parts)}    "
                f"被遮挡的候选匹配: {len(self._dbg.occluded)} 处")

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 30))
        if self._dbg is None:
            p.setPen(QColor(200, 200, 200))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "生成后此处显示所选行的对应关系")
            return

        w = len(self._dbg.links)
        W = max(1, self.width() - 20)
        sx = W / w
        x0 = 10

        # 1) 深度条 (亮=近)
        for x in range(w):
            g = int(np.clip(self._depth_row[x], 0, 1) * 255)
            p.fillRect(int(x0 + x * sx), 8, max(1, int(sx + 1)), 18,
                       QColor(g, g, g))
        p.setPen(QColor(180, 180, 180))
        p.drawText(10, 42, "深度 (亮=近)")

        # 2) 输出像素条
        if self._out_row is not None:
            for x in range(w):
                r, g, b = (int(v) for v in self._out_row[x])
                p.fillRect(int(x0 + x * sx), 50, max(1, int(sx + 1)), 18,
                           QColor(r, g, b))
        p.setPen(QColor(180, 180, 180))
        p.drawText(10, 84, "输出像素")

        # 3) 同名点连线 (颜色按距离区分)
        base_y = 100
        p.setFont(QFont("monospace", 8))
        drawn = 0
        for x in range(w):
            r = int(self._dbg.links[x])
            if r <= x:
                continue
            d = r - x
            hue = (d * 37) % 360
            p.setPen(QPen(QColor.fromHsv(hue, 200, 230), 1))
            xa, xb = x0 + x * sx, x0 + r * sx
            arc_h = 12 + (d % 5) * 6
            p.drawArc(int(xa), base_y, int(xb - xa), arc_h * 2, 0, 180 * 16)
            drawn += 1
            if drawn > 4000:
                break

        # 4) 被遮挡的候选匹配: 红色叉
        p.setPen(QPen(QColor(255, 70, 70), 2))
        for left, right in self._dbg.occluded:
            xm = x0 + (left + right) / 2 * sx
            p.drawLine(int(xm - 4), base_y + 46, int(xm + 4), base_y + 56)
            p.drawLine(int(xm - 4), base_y + 56, int(xm + 4), base_y + 46)
        p.setPen(QColor(255, 120, 120))
        p.drawText(10, base_y + 54, "红叉 = 被更近表面挡掉的匹配")
        p.end()


# ------------------------------------------------------------ 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("裸眼立体图生成器 (SIRDS)")
        self.resize(1280, 860)

        self._depth: np.ndarray | None = None
        self._output: np.ndarray | None = None
        self._texture: np.ndarray | None = None
        self._depth_file: str | None = None
        self._texture_file: str | None = None

        self._build_ui()
        self._regenerate()

    # ---------------- UI 搭建 ----------------

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # ---- 左侧参数面板 ----
        panel = QVBoxLayout()
        panel_w = QWidget()
        panel_w.setLayout(panel)
        panel_w.setFixedWidth(320)
        scroll = QScrollArea()
        scroll.setWidget(panel_w)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(340)
        root.addWidget(scroll)

        # 深度来源
        g_depth = QGroupBox("深度图 (亮=近, 暗=远)")
        f = QFormLayout(g_depth)
        self.cmb_depth = QComboBox()
        self.cmb_depth.addItems(
            ["plane 平面", "step 浮起台阶", "step_hole 带孔台阶", "加载灰度 PNG…"])
        f.addRow("样例", self.cmb_depth)
        self.sp_zfar = QDoubleSpinBox(minimum=0.0, maximum=1.0,
                                      singleStep=0.05, value=0.15)
        self.sp_znear = QDoubleSpinBox(minimum=0.0, maximum=1.0,
                                       singleStep=0.05, value=0.95)
        f.addRow("远层深度", self.sp_zfar)
        f.addRow("近层深度", self.sp_znear)
        panel.addWidget(g_depth)

        # 几何参数
        g_geo = QGroupBox("几何参数")
        f = QFormLayout(g_geo)
        self.sp_w = QSpinBox(minimum=64, maximum=4096, value=800)
        self.sp_h = QSpinBox(minimum=64, maximum=4096, value=600)
        self.sp_eye = QSpinBox(minimum=8, maximum=800, value=144)
        self.sp_eye.setToolTip("视距 E: 平行眼观看时两眼对应的屏幕像素间距")
        self.sp_mu = QDoubleSpinBox(minimum=0.05, maximum=0.9,
                                    singleStep=0.05, value=1 / 3)
        self.sp_mu.setToolTip("深度系数 mu: 最近处视差 = E × (1 − mu)")
        self.sp_pw = QSpinBox(minimum=4, maximum=800, value=144)
        self.sp_pw.setToolTip("纹理平铺宽度 (纹理模式下建议 ≤ 最近处视差)")
        f.addRow("图宽 px", self.sp_w)
        f.addRow("图高 px", self.sp_h)
        f.addRow("视距 E px", self.sp_eye)
        f.addRow("深度系数 mu", self.sp_mu)
        f.addRow("纹理宽度 px", self.sp_pw)
        panel.addWidget(g_geo)

        # 纹理
        g_tex = QGroupBox("纹理 / 随机源")
        f = QFormLayout(g_tex)
        self.cmb_dot = QComboBox()
        self.cmb_dot.addItems(["color 随机彩点", "bw 随机黑白点",
                               "texture 纹理块"])
        self.sp_seed = QSpinBox(minimum=0, maximum=999999, value=42)
        btn_tex = QPushButton("加载纹理图片…")
        btn_tex.clicked.connect(self._load_texture)
        self.lbl_tex = QLabel("(未加载, 用内置纹理)")
        self.lbl_tex.setWordWrap(True)
        f.addRow("模式", self.cmb_dot)
        f.addRow("随机种子", self.sp_seed)
        f.addRow(btn_tex)
        f.addRow(self.lbl_tex)
        panel.addWidget(g_tex)

        # 操作
        btn_gen = QPushButton("重新生成")
        btn_gen.clicked.connect(self._regenerate)
        panel.addWidget(btn_gen)
        btn_export = QPushButton("导出 PNG + 参数…")
        btn_export.clicked.connect(self._export)
        panel.addWidget(btn_export)

        self.lbl_warn = QLabel("")
        self.lbl_warn.setWordWrap(True)
        self.lbl_warn.setStyleSheet("color: #d08000; font-weight: bold;")
        panel.addWidget(self.lbl_warn)
        panel.addStretch(1)

        # ---- 右侧显示区 ----
        right = QVBoxLayout()
        right_w = QWidget()
        right_w.setLayout(right)
        root.addWidget(right_w, 1)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.tabs = QTabWidget()
        self.lbl_depth_view = QLabel(alignment=Qt.AlignmentFlag.AlignCenter)
        self.lbl_out_view = QLabel(alignment=Qt.AlignmentFlag.AlignCenter)
        self.lbl_depth_view.setMinimumSize(300, 300)
        self.lbl_out_view.setMinimumSize(300, 300)
        self.tabs.addTab(self.lbl_depth_view, "深度图")
        self.tabs.addTab(self.lbl_out_view, "立体图输出")
        splitter.addWidget(self.tabs)
        right.addWidget(splitter, 1)

        # 行检查器
        g_row = QGroupBox("行检查器: 实际输出点距离与被遮挡的匹配")
        v = QVBoxLayout(g_row)
        hrow = QHBoxLayout()
        hrow.addWidget(QLabel("行 y ="))
        self.sp_row = QSpinBox(minimum=0, maximum=599, value=300)
        self.sp_row.valueChanged.connect(self._update_row_inspector)
        hrow.addWidget(self.sp_row)
        self.lbl_row_info = QLabel("")
        hrow.addWidget(self.lbl_row_info, 1)
        v.addLayout(hrow)
        self.inspector = RowInspector()
        v.addWidget(self.inspector)
        right.addWidget(g_row)

        # 参数变化即重新生成
        self.cmb_depth.currentIndexChanged.connect(self._depth_source_changed)
        self.cmb_dot.currentIndexChanged.connect(self._regenerate)
        for w_ in (self.sp_w, self.sp_h, self.sp_eye, self.sp_pw, self.sp_seed):
            w_.valueChanged.connect(self._regenerate)
        for w_ in (self.sp_mu, self.sp_zfar, self.sp_znear):
            w_.valueChanged.connect(self._regenerate)

    # ---------------- 参数收集 ----------------

    def _params(self) -> RenderParams:
        kind = ["plane", "step", "step_hole", "custom"][
            self.cmb_depth.currentIndex()]
        mode = ["color", "bw", "texture"][self.cmb_dot.currentIndex()]
        return RenderParams(
            width=self.sp_w.value(), height=self.sp_h.value(),
            eye_sep=self.sp_eye.value(), mu=self.sp_mu.value(),
            pattern_width=self.sp_pw.value(), seed=self.sp_seed.value(),
            dot_mode=mode, depth_kind=kind,
            z_far=self.sp_zfar.value(), z_near=self.sp_znear.value(),
        )

    def _current_texture(self) -> np.ndarray | None:
        if self.cmb_dot.currentIndex() != 2:
            return None
        if self._texture is not None:
            return self._texture
        return make_default_texture(self._params())

    # ---------------- 行为 ----------------

    def _depth_source_changed(self):
        if self.cmb_depth.currentIndex() == 3:  # 加载 PNG
            path, _ = QFileDialog.getOpenFileName(
                self, "选择灰度深度图 PNG", "", "图片 (*.png *.jpg *.bmp)")
            if path:
                self._depth_file = path
            else:
                self.cmb_depth.setCurrentIndex(1)  # 取消则回到台阶
                return
        else:
            self._depth_file = None
        self._regenerate()

    def _load_texture(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择纹理图片", "", "图片 (*.png *.jpg *.bmp)")
        if path:
            self._texture = load_texture(path)
            self._texture_file = path
            self.lbl_tex.setText(Path(path).name)
            self.cmb_dot.setCurrentIndex(2)
            self._regenerate()

    def _regenerate(self):
        p = self._params()
        self.sp_row.setMaximum(p.height - 1)

        # 深度图
        if p.depth_kind == "custom" and self._depth_file:
            self._depth = load_gray_png(self._depth_file, p.width, p.height)
        else:
            if p.depth_kind == "custom":
                p.depth_kind = "step"
            self._depth = make_depth(p)

        # 渲染
        tex = self._current_texture()
        self._output, _ = render_sirds(self._depth, p, texture=tex)
        self._last_params = p

        # 显示
        self._show(self.lbl_depth_view, depth_to_gray(self._depth))
        self._show(self.lbl_out_view, self._output)

        # 警告
        warns = validate_params(p, has_texture=(tex is not None))
        self.lbl_warn.setText("\n".join("⚠ " + w for w in warns))

        self._update_row_inspector()

    def _show(self, label: QLabel, arr: np.ndarray):
        pm = QPixmap.fromImage(np_to_qimage(arr))
        label.setPixmap(pm.scaled(label.size(),
                                  Qt.AspectRatioMode.KeepAspectRatio,
                                  Qt.TransformationMode.FastTransformation))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        if self._depth is not None:
            self._show(self.lbl_depth_view, depth_to_gray(self._depth))
            self._show(self.lbl_out_view, self._output)

    def _update_row_inspector(self):
        if self._depth is None or self._output is None:
            return
        y = min(self.sp_row.value(), self._depth.shape[0] - 1)
        p = self._last_params
        dbg = analyze_row(self._depth, y, p.eye_sep, p.mu)
        self.inspector.set_row(self._depth[y], self._output[y], dbg)
        self.lbl_row_info.setText(self.inspector.summary())

    def _export(self):
        if self._output is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出立体图", "sirds.png", "PNG 图片 (*.png)")
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"

        # 原像素大小写出
        np_to_qimage(self._output).save(path, "PNG")

        # 参数 sidecar
        settings = params_to_dict(self._last_params)
        settings["depth_file"] = self._depth_file
        settings["texture_file"] = self._texture_file
        settings["note"] = ("depth: 0=最远 1=最近; "
                            "separation(z)=round((1-mu*z)*eye_sep)")
        sidecar = str(Path(path).with_suffix(".json"))
        Path(sidecar).write_text(json.dumps(settings, ensure_ascii=False,
                                            indent=2), encoding="utf-8")
        QMessageBox.information(
            self, "导出完成",
            f"已导出:\n{path}\n{sidecar}\n\n"
            f"尺寸 {self._output.shape[1]}×{self._output.shape[0]} px, "
            f"种子 {self._last_params.seed}, 相同参数可完整复现。")


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
