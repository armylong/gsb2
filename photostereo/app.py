"""PySide6 主窗口: 光度立体演示工作台."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPen, QPainter, QColor
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QVBoxLayout,
    QWidget,
)

from . import encoding
from .geometry import dir_to_spherical, ring_rig, spherical_to_dir
from .solver import reason_text, relight, solve_photometric
from .synthetic import (
    make_bumpy_plate_scene,
    make_hemisphere_scene,
    render,
)
from .widgets import ImageView


# 灯架预设: (名称, 方位角列表, 仰角, 亮度列表说明)
def _preset_rigs():
    good = ring_rig(8, 45.0, 22.5)
    # 留出一盏做并排检查: 第 8 盏作为 held-out
    held = spherical_to_dir(180.0, 45.0)
    return {
        "标准环布 8 灯 + 1 留出灯": (
            np.vstack([good, held]),
            np.ones(9),
            8,  # 参与求解的灯数, 其余为留出
        ),
        "含过曝强灯 (3 倍亮度)": (
            ring_rig(6, 50.0, 15.0),
            np.array([1.0, 1.0, 3.0, 1.0, 3.0, 1.0]),
            6,
        ),
        "灯方向过于接近 (退化)": (
            np.stack(
                [
                    spherical_to_dir(35, 45),
                    spherical_to_dir(42, 45),
                    spherical_to_dir(49, 45),
                    spherical_to_dir(56, 45),
                    spherical_to_dir(200, 40),
                ]
            ),
            np.ones(5),
            5,
        ),
        "4 灯常规 + 1 留出灯": (
            np.vstack([ring_rig(4, 45.0, 45.0), spherical_to_dir(150.0, 55.0)]),
            np.ones(5),
            4,
        ),
    }


class LightDial(QWidget):
    """极坐标灯盘: 圆点拖动选择新光源方向, 实时发出单位向量."""

    light_changed = Signal(object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(170, 170)
        self._el = 45.0
        self._az = 90.0
        self._drag = False
        self._fixed_rigs: list[tuple[float, float]] = []

    def set_fixed_lights(self, directions: np.ndarray):
        self._fixed_rigs = [dir_to_spherical(d) for d in directions]
        self.update()

    def direction(self) -> np.ndarray:
        return spherical_to_dir(self._az, self._el)

    def _marker_pos(self, az: float, el: float):
        r = (1.0 - el / 90.0) * (self.width() / 2 - 12)
        a = np.deg2rad(az)
        cx, cy = self.width() / 2, self.height() / 2
        return cx + r * np.cos(a), cy + r * np.sin(a)

    def _update_from_mouse(self, ev):
        cx, cy = self.width() / 2, self.height() / 2
        dx, dy = ev.position().x() - cx, ev.position().y() - cy
        rmax = self.width() / 2 - 12
        r = min(np.hypot(dx, dy), rmax)
        self._az = float(np.rad2deg(np.arctan2(dy, dx)) % 360)
        self._el = float(max(5.0, 90.0 * (1.0 - r / rmax)))
        self.update()
        self.light_changed.emit(self.direction())

    def mousePressEvent(self, ev):
        self._drag = True
        self._update_from_mouse(ev)

    def mouseMoveEvent(self, ev):
        if self._drag:
            self._update_from_mouse(ev)

    def mouseReleaseEvent(self, _ev):
        self._drag = False

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor(30, 30, 34))
        cx, cy = self.width() / 2, self.height() / 2
        rmax = self.width() / 2 - 12
        pen = QPen(QColor(90, 90, 90), 1)
        p.setPen(pen)
        for frac in (1 / 3, 2 / 3, 1.0):
            p.drawEllipse(int(cx - rmax * frac), int(cy - rmax * frac),
                          int(2 * rmax * frac), int(2 * rmax * frac))
        p.drawLine(int(cx - rmax), int(cy), int(cx + rmax), int(cy))
        p.drawLine(int(cx), int(cy - rmax), int(cx), int(cy + rmax))
        p.setPen(QColor(160, 160, 160))
        p.drawText(int(cx + rmax - 14), int(cy - 4), "x+")
        p.drawText(int(cx + 4), int(cy + rmax - 2), "y+")
        p.drawText(int(cx + 4), int(cy - rmax + 12), "头顶")

        # 固定灯: 空心方块
        p.setPen(QPen(QColor(110, 170, 255), 1.5))
        p.setBrush(QColor(110, 170, 255, 90))
        for az, el in self._fixed_rigs:
            x, y = self._marker_pos(az, el)
            p.drawRect(int(x) - 3, int(y) - 3, 6, 6)

        # 可拖动光源: 黄色实心圆
        x, y = self._marker_pos(self._az, self._el)
        p.setPen(QPen(QColor(255, 220, 60), 2))
        p.setBrush(QColor(255, 220, 60))
        p.drawEllipse(int(x) - 5, int(y) - 5, 10, 10)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("光度立体: 从多灯灰度图还原表面朝向")
        self.rng = np.random.default_rng(7)
        self.rigs = _preset_rigs()
        self.scene = None
        self.render = None
        self.result = None
        self.enabled: np.ndarray | None = None
        self.cursor: tuple[int, int] | None = None
        self._build_ui()
        self.reload_scene()

    # ---------------- UI 搭建 ----------------
    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        layout = QHBoxLayout(root)

        # ===== 左侧控制区 =====
        left = QVBoxLayout()
        layout.addLayout(left, 0)

        scene_box = QGroupBox("演示场景 (已知真值)")
        sb = QVBoxLayout(scene_box)
        self.scene_combo = QComboBox()
        self.scene_combo.addItems(["半球: 单一材料, 只有朝向变化",
                                   "起伏板: 暗色贴纸, 颜色与朝向分离"])
        self.scene_combo.currentIndexChanged.connect(self.reload_scene)
        sb.addWidget(self.scene_combo)
        self.shadow_check = QCheckBox("渲染自遮挡阴影 (低角度灯)")
        self.shadow_check.setChecked(True)
        self.shadow_check.stateChanged.connect(self.reload_scene)
        sb.addWidget(self.shadow_check)
        left.addWidget(scene_box)

        rig_box = QGroupBox("灯架 / 照明条件")
        rb = QVBoxLayout(rig_box)
        self.rig_combo = QComboBox()
        self.rig_combo.addItems(list(self.rigs.keys()))
        self.rig_combo.currentIndexChanged.connect(self.reload_scene)
        rb.addWidget(self.rig_combo)
        self.light_checks_box = QGroupBox("参与求解的灯 (取消勾选=换掉/剔除该图)")
        self.light_layout = QVBoxLayout(self.light_checks_box)
        rb.addWidget(self.light_checks_box)
        self.rig_label = QLabel()
        self.rig_label.setWordWrap(True)
        rb.addWidget(self.rig_label)
        left.addWidget(rig_box)

        relight_box = QGroupBox("拖动新光源 -> 重新打光")
        rl = QVBoxLayout(relight_box)
        self.dial = LightDial()
        self.dial.light_changed.connect(self.on_dial_changed)
        rl.addWidget(self.dial)
        self.dial_label = QLabel()
        rl.addWidget(self.dial_label)
        left.addWidget(relight_box)

        export_box = QGroupBox("导出")
        eb = QVBoxLayout(export_box)
        btn_export = QPushButton("导出朝向图 + 有效掩膜…")
        btn_export.clicked.connect(self.export_files)
        eb.addWidget(btn_export)
        self.export_status = QLabel("通道约定: R=nx, G=ny, B=nz (见 sidecar JSON)")
        self.export_status.setWordWrap(True)
        eb.addWidget(self.export_status)
        left.addWidget(export_box)
        left.addStretch(1)

        # ===== 右侧图像区 =====
        right = QVBoxLayout()
        layout.addLayout(right, 1)

        self.views: dict[str, ImageView] = {}
        grid = QGridLayout()
        titles = [
            ("input0", "输入图 1"), ("normals", "估计朝向图 (R=nx G=ny B=nz)"),
            ("input1", "输入图 2"), ("albedo", "反射强度 (材料颜色)"),
            ("input2", "输入图 3"), ("conf", "可信度 (亮=可信, 红叉=无效)"),
        ]
        for i, (key, title) in enumerate(titles):
            v = ImageView(title)
            v.pixel_clicked.connect(self.on_pixel_clicked)
            v.pixel_hovered.connect(self.on_pixel_hovered)
            self.views[key] = v
            grid.addWidget(v, i // 2, i % 2)
        right.addLayout(grid, 2)

        bottom = QGridLayout()
        self.views["relight"] = ImageView("重打光 (拖动左侧光源)")
        self.views["heldout"] = ImageView("留出灯真实渲染 (并排检查)")
        self.views["diff"] = ImageView("差异 |估计-真实|")
        for v in (self.views["relight"], self.views["heldout"], self.views["diff"]):
            v.pixel_clicked.connect(self.on_pixel_clicked)
            v.pixel_hovered.connect(self.on_pixel_hovered)
        bottom.addWidget(self.views["relight"], 0, 0)
        bottom.addWidget(self.views["heldout"], 0, 1)
        bottom.addWidget(self.views["diff"], 0, 2)
        right.addLayout(bottom, 1)

        # ===== 像素检查器 =====
        inspector = QGroupBox("像素检查器: 点任意图像查看该像素在各张图的亮度")
        il = QVBoxLayout(inspector)
        self.inspector = QPlainTextEdit()
        self.inspector.setReadOnly(True)
        self.inspector.setMaximumHeight(170)
        il.addWidget(self.inspector)
        right.addWidget(inspector, 0)

    # ---------------- 数据装载与求解 ----------------
    def reload_scene(self):
        if self.scene_combo.currentIndex() == 0:
            self.scene = make_hemisphere_scene(size=150)
        else:
            self.scene = make_bumpy_plate_scene(size=150)

        rig_name = self.rig_combo.currentText()
        directions, strengths, n_solve = self.rigs[rig_name]
        self.n_solve = n_solve
        self.render = render(
            self.scene,
            directions,
            strengths,
            rng=self.rng,
            cast_shadows=self.shadow_check.isChecked(),
        )
        # 灯勾选框
        while self.light_layout.count():
            item = self.light_layout.takeAt(0)
            item.widget().deleteLater()
        self.light_checks: list[QCheckBox] = []
        for k in range(len(directions)):
            az, el = dir_to_spherical(directions[k])
            tag = f"灯{k}: 方位{az:5.1f}° 仰角{el:4.1f}° 亮度{strengths[k]:.2f}"
            if k >= n_solve:
                tag += "  [留出, 不参与求解]"
            cb = QCheckBox(tag)
            cb.setChecked(k < n_solve)
            cb.stateChanged.connect(self.resolve)
            self.light_checks.append(cb)
            self.light_layout.addWidget(cb)
        cond = np.linalg.svd(directions[:n_solve], compute_uv=False)
        self.rig_label.setText(
            f"参与求解灯数: {n_solve}    灯架条件数: {cond[0]/cond[-1]:.2f}\n"
            "条件数越大越接近共面; >15 的像素会被标低可信。"
        )
        self.dial.set_fixed_lights(directions[:n_solve])
        self.cursor = (self.scene.height.shape[0] // 2,
                       self.scene.height.shape[1] // 2)
        self.resolve()

    def resolve(self):
        r = self.render
        k = r.images.shape[0]
        self.enabled = np.array([cb.isChecked() for cb in self.light_checks], bool)
        self.result = solve_photometric(
            r.images, r.directions, r.strengths,
            saturation=r.saturation, enabled=self.enabled,
        )
        self.refresh_views()
        if self.cursor is not None:
            self.update_inspector(*self.cursor)

    def refresh_views(self):
        r, res, scene = self.render, self.result, self.scene
        invalid = ~res.valid
        for i, key in enumerate(("input0", "input1", "input2")):
            self.views[key].set_gray(r.images[i], vmax=1.0)
            self.views[key].set_cursor(self.cursor)
        self.views["normals"].set_rgb(
            encoding.encode_normals_rgb(res.normals, res.valid), invalid
        )
        self.views["albedo"].set_gray(res.albedo, vmax=1.0)
        self.views["albedo"].set_cursor(self.cursor)
        # 可信度图: 绿色亮度表示可信, 红叉由 ImageView 画
        self._paint_confidence(invalid)
        # 留出灯并排检查
        if r.images.shape[0] > self.n_solve:
            held = self.n_solve  # 第一盏留出灯
            actual = r.images[held]
            pred = relight(res, r.directions[held])
            self.views["heldout"].set_gray(actual, vmax=1.0)
            self.views["relight"].set_gray(pred, invalid=invalid, vmax=1.0)
            diff = np.abs(pred - actual)
            diff[invalid] = 0.0
            self.views["diff"].set_gray(diff, invalid=invalid, vmax=0.25)
        else:
            self.on_dial_changed(self.dial.direction())
        for key in ("relight", "heldout", "diff", "normals"):
            self.views[key].set_cursor(self.cursor)
        if self.cursor is not None:
            self.update_inspector(*self.cursor)

    def _paint_confidence(self, invalid):
        # 可信度视图用彩色: 绿亮表示可信, 红叉由 ImageView 画
        conf = self.result.confidence
        rgb = np.zeros((*conf.shape, 3), np.uint8)
        rgb[..., 1] = (conf * 255).astype(np.uint8)
        rgb[..., 0] = ((1 - conf) * 120).astype(np.uint8)
        self.views["conf"].set_rgb(rgb, invalid=invalid)

    # ---------------- 交互 ----------------
    def on_pixel_clicked(self, y: int, x: int):
        self.cursor = (y, x)
        for v in self.views.values():
            v.set_cursor(self.cursor)
        self.update_inspector(y, x)

    def on_pixel_hovered(self, y: int, x: int):
        # 悬停只更新检查器, 不改十字 (避免闪烁)
        self.update_inspector(y, x, hover=True)

    def on_dial_changed(self, direction: np.ndarray):
        if self.result is None:
            return
        img = relight(self.result, direction)
        self.views["relight"].set_gray(img, invalid=~self.result.valid, vmax=1.0)
        self.views["relight"].set_cursor(self.cursor)
        az, el = dir_to_spherical(direction)
        self.dial_label.setText(
            f"新光源: 方位 {az:6.1f}°  仰角 {el:5.1f}°\n"
            f"方向向量 ({direction[0]:+.3f}, {direction[1]:+.3f}, {direction[2]:+.3f})"
        )

    def update_inspector(self, y: int, x: int, hover: bool = False):
        res, r, scene = self.result, self.render, self.scene
        lines = [f"{'悬停' if hover else '选中'}像素 (y={y}, x={x})"]
        lines.append(
            f"状态: {reason_text(int(res.status[y, x]))}   "
            f"置信度: {res.confidence[y, x]:.3f}   条件数: "
            f"{res.condition[y, x]:.2f}   拟合残差: {res.fit_residual[y, x]:.4f}"
        )
        n = res.normals[y, x]
        lines.append(
            f"估计法线: ({n[0]:+.3f}, {n[1]:+.3f}, {n[2]:+.3f})   "
            f"估计反照率: {res.albedo[y, x]:.3f}"
        )
        if scene is not None and scene.mask[y, x]:
            tn = scene.normals[y, x]
            dot = np.clip(float(n @ tn), -1, 1)
            ang = np.rad2deg(np.arccos(dot)) if res.valid[y, x] else float("nan")
            lines.append(
                f"真值法线: ({tn[0]:+.3f}, {tn[1]:+.3f}, {tn[2]:+.3f})   "
                f"真值反照率: {scene.albedo[y, x]:.3f}   方向误差: {ang:.2f}°"
            )
        lines.append("各灯观测 (✓=该像素实际用上, 曝=过曝, 暗=低于阈值, 挡=阴影, 弃=手动剔除):")
        for k in range(r.images.shape[0]):
            flags = []
            if not self.enabled[k]:
                flags.append("弃")
            if r.saturated[k, y, x]:
                flags.append("曝")
            if r.images[k, y, x] < res.min_intensity:
                flags.append("暗")
            if r.shadows[k, y, x]:
                flags.append("挡")
            used = "✓" if res.used[k, y, x] else " "
            lines.append(
                f"  灯{k} [{used}] 亮度 {r.images[k, y, x]:.4f}  "
                f"(灯强 {r.strengths[k]:.2f}) {','.join(flags)}"
            )
        self.inspector.setPlainText("\n".join(lines))

    # ---------------- 导出 ----------------
    def export_files(self):
        if self.result is None:
            return
        out = QFileDialog.getExistingDirectory(self, "选择导出目录", str(Path.cwd()))
        if not out:
            return
        stem = "hemisphere" if self.scene_combo.currentIndex() == 0 else "bumpy_plate"
        files = encoding.export_result(Path(out), stem, self.result)
        # 回读验证
        n_back, valid_back = encoding.import_normal_map(files["normals"], files["mask"])
        valid = self.result.valid & valid_back
        if valid.any():
            ang = np.rad2deg(
                np.arccos(np.clip(np.sum(n_back * self.result.normals, -1), -1, 1))
            )
            msg = (
                f"已导出 4 个文件到 {out}\n\n"
                f"回读校验: {valid.sum()} 个有效像素, 方向最大偏差 {ang[valid].max():.3f}°\n"
                "通道约定写入 sidecar JSON: R=nx, G=ny, B=nz"
            )
        else:
            msg = f"已导出, 但当前没有有效像素可回读校验。"
        self.export_status.setText(msg.split("\n")[0])
        QMessageBox.information(self, "导出完成", msg)


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.resize(1280, 940)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
