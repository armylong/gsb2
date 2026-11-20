"""双色印刷墨量估算 —— PySide6 主窗口。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (QColorDialog, QComboBox, QDoubleSpinBox, QFileDialog,
                               QFormLayout, QGridLayout, QGroupBox, QHBoxLayout,
                               QLabel, QMainWindow, QMessageBox, QPushButton,
                               QScrollArea, QSplitter, QVBoxLayout, QWidget)

from .. import color as C
from .. import png
from ..curves import ToneCurve
from ..export import export_all
from ..model import InkParams
from ..samples import make_check_strip, make_color_chart, make_gradient
from ..separation import heat_colormap, rerender
from .curve_editor import CurveEditor
from .histogram import HistogramWidget
from .image_pane import ImagePane
from .worker import start_worker

DEFAULT_PAPER = "#f4ecd8"
DEFAULT_INK_A = "#1a5fb4"
DEFAULT_INK_B = "#c01c28"


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("双色印刷墨量估算（双墨 Neugebauer 草稿）")
        self.resize(1480, 940)

        # 状态
        self.target_rgb = make_gradient(480, 300)
        self.inks = InkParams.from_hex(DEFAULT_PAPER, DEFAULT_INK_A, DEFAULT_INK_B)
        self.curve_a = ToneCurve.linear()
        self.curve_b = ToneCurve.linear()
        self.tac = 2.0
        self.grid_n = 41
        self.sep: dict | None = None
        self.result = None
        self._thread = None
        self._busy = False

        self._build_ui()
        self._refresh_ink_buttons()
        self.run_separation()

    # ---------------------------------------------------------------- UI
    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)

        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_center_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter)
        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

    def _build_left_panel(self) -> QWidget:
        panel = QWidget()
        panel.setMinimumWidth(380)
        panel.setMaximumWidth(460)
        outer = QVBoxLayout(panel)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        inner = QWidget()
        lay = QVBoxLayout(inner)

        # --- 输入 ---
        g_in = QGroupBox("1. 输入图像（程序内可直接生成样例）")
        v = QVBoxLayout(g_in)
        self.combo_source = QComboBox()
        self.combo_source.addItems(["内置：色相×明度渐变", "内置：16 色块色卡", "从 PNG 打开…"])
        btn_gen = QPushButton("生成/载入")
        btn_gen.clicked.connect(self._load_source)
        v.addWidget(self.combo_source)
        v.addWidget(btn_gen)
        lay.addWidget(g_in)

        # --- 颜色 ---
        g_col = QGroupBox("2. 纸色与两种墨色（叠印色按透明墨串联模型自动推导）")
        form = QFormLayout(g_col)
        self.btn_paper = QPushButton()
        self.btn_ink_a = QPushButton()
        self.btn_ink_b = QPushButton()
        self.btn_op = QPushButton("自动")
        for b, slot in ((self.btn_paper, self._pick_paper),
                        (self.btn_ink_a, self._pick_ink_a),
                        (self.btn_ink_b, self._pick_ink_b),
                        (self.btn_op, self._pick_overprint)):
            b.clicked.connect(slot)
            b.setMinimumHeight(26)
        form.addRow("纸色", self.btn_paper)
        form.addRow("墨 A（版 A）", self.btn_ink_a)
        form.addRow("墨 B（版 B）", self.btn_ink_b)
        form.addRow("叠印色 A+B", self.btn_op)
        self.lbl_model_note = QLabel()
        self.lbl_model_note.setWordWrap(True)
        self.lbl_model_note.setStyleSheet("color:#8a5a00;")
        form.addRow(self.lbl_model_note)
        lay.addWidget(g_col)

        # --- 限墨 ---
        g_lim = QGroupBox("3. 限墨（TAC：两版总覆盖率上限）")
        lh = QHBoxLayout(g_lim)
        self.spin_tac = QDoubleSpinBox()
        self.spin_tac.setRange(0.1, 2.0)
        self.spin_tac.setSingleStep(0.05)
        self.spin_tac.setValue(self.tac)
        self.spin_tac.valueChanged.connect(self._on_tac)
        lh.addWidget(self.spin_tac)
        lh.addWidget(QLabel("1.00 = 单版满覆；2.00 = 不限制"))
        lay.addWidget(g_lim)

        # --- 曲线 ---
        g_cv = QGroupBox("4. 分别调整两版曲线（双击加点/右键删点，拖动控制点）")
        cv = QGridLayout(g_cv)
        self.editor_a = CurveEditor("版 A 调墨曲线", DEFAULT_INK_A)
        self.editor_b = CurveEditor("版 B 调墨曲线", DEFAULT_INK_B)
        self.editor_a.changed.connect(self._on_curve_a)
        self.editor_b.changed.connect(self._on_curve_b)
        self.editor_a.probeText.connect(lambda s: self.statusBar().showMessage(s))
        self.editor_b.probeText.connect(lambda s: self.statusBar().showMessage(s))
        cv.addWidget(self.editor_a, 0, 0)
        cv.addWidget(self.editor_b, 0, 1)
        lay.addWidget(g_cv)

        # --- 导出 ---
        g_ex = QGroupBox("5. 导出与检查用例")
        eh = QVBoxLayout(g_ex)
        btn_export = QPushButton("导出两版/预览/误差图/检查条/JSON 到目录…")
        btn_export.clicked.connect(self._export)
        btn_strip = QPushButton("弹出检查用例条（空纸·纯墨A·纯墨B·叠印）")
        btn_strip.clicked.connect(self._show_strip)
        eh.addWidget(btn_export)
        eh.addWidget(btn_strip)
        lay.addWidget(g_ex)
        lay.addStretch(1)

        scroll.setWidget(inner)
        outer.addWidget(scroll)
        return panel

    def _build_center_panel(self) -> QWidget:
        panel = QWidget()
        v = QVBoxLayout(panel)

        self.panes: dict[str, ImagePane] = {}
        grid = QGridLayout()
        specs = [
            ("target", "目标图（输入）", 0, 0),
            ("plate_a", "墨版 A（灰度，白=满墨）", 0, 1),
            ("plate_b", "墨版 B（灰度，白=满墨）", 0, 2),
            ("preview", "双色合成预览（重算）", 1, 0),
            ("err", "ΔE00 误差热图（单色相蓝阶）", 1, 1),
        ]
        for key, title, r, c in specs:
            pane = ImagePane(title)
            pane.clickedAt.connect(self._probe)
            self.panes[key] = pane
            grid.addWidget(pane, r, c)
        # 第 6 格放统计
        self.stats_box = QGroupBox("墨量与误差统计")
        sv = QVBoxLayout(self.stats_box)
        self.lbl_stats = QLabel("计算中…")
        self.lbl_stats.setWordWrap(True)
        self.lbl_stats.setTextInteractionFlags(Qt.TextSelectableByMouse)
        sv.addWidget(self.lbl_stats)
        grid.addWidget(self.stats_box, 1, 2)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(2, 1)
        v.addLayout(grid, 2)

        # 直方图区
        hg = QGroupBox("覆盖率与误差分布（单轴直方图）")
        hl = QHBoxLayout(hg)
        self.hist_a = HistogramWidget("版 A 覆盖率分布", DEFAULT_INK_A)
        self.hist_b = HistogramWidget("版 B 覆盖率分布", DEFAULT_INK_B)
        self.hist_e = HistogramWidget("ΔE00 误差分布（横轴上限=P99 截尾）", "#08306b")
        for w in (self.hist_a, self.hist_b, self.hist_e):
            hl.addWidget(w)
        v.addWidget(hg, 0)
        return panel

    # ---------------------------------------------------------------- 颜色
    def _color_button_text(self, hexstr: str) -> str:
        return f"{hexstr}  （点击选择）"

    def _refresh_ink_buttons(self):
        p = self.inks
        self.btn_paper.setText(self._color_button_text(C.rgb_to_hex(p.paper_rgb)))
        self.btn_ink_a.setText(self._color_button_text(C.rgb_to_hex(p.solid_a_rgb)))
        self.btn_ink_b.setText(self._color_button_text(C.rgb_to_hex(p.solid_b_rgb)))
        self.btn_op.setText(self._color_button_text(C.rgb_to_hex(p.overprint_rgb)))
        for btn, rgb in ((self.btn_paper, p.paper_rgb), (self.btn_ink_a, p.solid_a_rgb),
                         (self.btn_ink_b, p.solid_b_rgb), (self.btn_op, p.overprint_rgb)):
            hx = C.rgb_to_hex(rgb)
            btn.setStyleSheet(
                f"background:{hx}; color:{'#000' if _luminance(rgb) > 0.4 else '#fff'};")
        warn = "⚠ 透明墨串联假设在某通道超出 [0,1]，叠印色已截断。" if p.clamp_warned else ""
        self.lbl_model_note.setText(
            "模型：Demichel 面积混合 Neugebauer；叠印=W·tA·tB（透明墨串联）。" + warn)
        self.editor_a.ink_color = QColor(C.rgb_to_hex(p.solid_a_rgb))
        self.editor_b.ink_color = QColor(C.rgb_to_hex(p.solid_b_rgb))
        self.hist_a.bar = QColor(C.rgb_to_hex(p.solid_a_rgb))
        self.hist_b.bar = QColor(C.rgb_to_hex(p.solid_b_rgb))

    def _pick(self, current_hex: str) -> str | None:
        c = QColorDialog.getColor(QColor(current_hex), self, "选择颜色")
        return c.name() if c.isValid() else None

    def _pick_paper(self):
        hx = self._pick(C.rgb_to_hex(self.inks.paper_rgb))
        if hx:
            self.inks = InkParams.from_hex(hx, C.rgb_to_hex(self.inks.solid_a_rgb),
                                           C.rgb_to_hex(self.inks.solid_b_rgb))
            self._after_ink_change()

    def _pick_ink_a(self):
        hx = self._pick(C.rgb_to_hex(self.inks.solid_a_rgb))
        if hx:
            self.inks = InkParams.from_hex(C.rgb_to_hex(self.inks.paper_rgb), hx,
                                           C.rgb_to_hex(self.inks.solid_b_rgb))
            self._after_ink_change()

    def _pick_ink_b(self):
        hx = self._pick(C.rgb_to_hex(self.inks.solid_b_rgb))
        if hx:
            self.inks = InkParams.from_hex(C.rgb_to_hex(self.inks.paper_rgb),
                                           C.rgb_to_hex(self.inks.solid_a_rgb), hx)
            self._after_ink_change()

    def _pick_overprint(self):
        hx = self._pick(C.rgb_to_hex(self.inks.overprint_rgb))
        if hx:
            self.inks = InkParams.from_hex(
                C.rgb_to_hex(self.inks.paper_rgb), C.rgb_to_hex(self.inks.solid_a_rgb),
                C.rgb_to_hex(self.inks.solid_b_rgb), overprint_hex=hx)
            self._after_ink_change()

    def _after_ink_change(self):
        self._refresh_ink_buttons()
        self.run_separation()

    # ---------------------------------------------------------------- 输入
    def _load_source(self):
        idx = self.combo_source.currentIndex()
        if idx == 0:
            self.target_rgb = make_gradient(480, 300)
        elif idx == 1:
            self.target_rgb = make_color_chart(swatch=80, cols=4)
        else:
            path, _ = QFileDialog.getOpenFileName(self, "打开 PNG", "", "PNG 图像 (*.png)")
            if not path:
                return
            try:
                u8 = png.read_png_rgb_u8(path)
            except Exception as exc:  # noqa: BLE001
                QMessageBox.warning(self, "读取失败", str(exc))
                return
            from ..samples import srgb_image_to_rgb
            self.target_rgb = srgb_image_to_rgb(u8)
        self.panes["target"].set_rgb(self.target_rgb)
        self.run_separation()

    # ---------------------------------------------------------------- 管线
    def run_separation(self):
        if self._busy:
            self.statusBar().showMessage("上一次分色仍在进行，请稍候…")
            return
        self._busy = True
        self.statusBar().showMessage("分色计算中（色域搜索，后台线程）…")
        self._thread, _ = start_worker(
            self.target_rgb, self.inks, self.grid_n,
            on_finished=self._on_sep_finished, on_failed=self._on_sep_failed)

    def _on_sep_failed(self, msg: str):
        self._busy = False
        QMessageBox.critical(self, "分色失败", msg)

    def closeEvent(self, e):
        try:
            if self._thread is not None and self._thread.isRunning():
                self._thread.wait(5000)
        except RuntimeError:
            pass  # 线程 C++ 对象已被 deleteLater 回收
        super().closeEvent(e)

    def _on_sep_finished(self, sep: dict, inks: InkParams):
        self._busy = False
        self.sep = sep
        self.inks = inks
        self._rerender()

    def _rerender(self):
        if self.sep is None:
            return
        self.result = rerender(self.sep, self.target_rgb, self.inks,
                               self.curve_a, self.curve_b, self.tac)
        r = self.result
        self.panes["target"].set_rgb(r.target_rgb)
        self.panes["plate_a"].set_coverage(r.a_final)
        self.panes["plate_b"].set_coverage(r.b_final)
        self.panes["preview"].set_rgb(r.pred_rgb_final)
        self.panes["err"].set_rgb(heat_colormap(r.de_final))
        self.hist_a.set_values(r.a_final, (0.0, 1.0))
        self.hist_b.set_values(r.b_final, (0.0, 1.0))
        vmax = max(float(np.percentile(r.de_final, 99)), 1.0)
        self.hist_e.set_values(np.clip(r.de_final, 0, vmax), (0.0, vmax))
        self._render_stats()
        self.statusBar().showMessage("分色完成")

    def _render_stats(self):
        r = self.result
        u, sf, sr = r.ink, r.stats_final, r.stats_raw
        oog = r.out_of_gamut_mask.mean()
        html = f"""
        <b>墨量估算</b>（覆盖率均值；总量单位=像素面积×覆盖率和）<br>
        版 A 平均覆盖率：{u['plate_a_mean_coverage']:.3f}｜墨量单位：{u['plate_a_ink_units']:.0f}<br>
        版 B 平均覆盖率：{u['plate_b_mean_coverage']:.3f}｜墨量单位：{u['plate_b_ink_units']:.0f}<br>
        合计墨量单位：{u['total_ink_units']:.0f}｜实际最大 TAC：{u['max_total_area_coverage']:.3f}（上限 {r.tac:.2f}）<br><br>
        <b>色域外</b>：{oog:.2%} 像素（到色域最近样本 ΔE00 &gt; 1.0）<br><br>
        <b>ΔE00 误差（最终：曲线+限墨后）</b><br>
        均值 {sf['mean']:.2f}｜中位 {sf['median']:.2f}｜P95 {sf['p95']:.2f}｜P99 {sf['p99']:.2f}｜最大 {sf['max']:.2f}<br>
        ΔE&gt;2 占 {sf['fraction_de_gt_2']:.2%}｜ΔE&gt;5 占 {sf['fraction_de_gt_5']:.2%}<br>
        <b>ΔE00 误差（原始分色，未加曲线/限墨）</b><br>
        均值 {sr['mean']:.2f}｜P95 {sr['p95']:.2f}｜最大 {sr['max']:.2f}
        """
        self.lbl_stats.setText(html)

    # ---------------------------------------------------------------- 交互
    def _on_tac(self, v: float):
        self.tac = float(v)
        self._rerender()

    def _on_curve_a(self, tc: ToneCurve):
        self.curve_a = tc.normalized()
        self._rerender()

    def _on_curve_b(self, tc: ToneCurve):
        self.curve_b = tc.normalized()
        self._rerender()

    def _probe(self, row: int, col: int):
        if self.result is None:
            return
        d = self.result.probe(row, col)
        self.statusBar().showMessage(
            f"探针 ({row},{col}) 目标 {d['target_hex']} → 合成 {d['predicted_hex']}｜"
            f"版A 原始 {d['plate_a_raw']:.3f} → 曲线后 {d['plate_a_after_curve']:.3f} → 终版 {d['plate_a_final']:.3f}｜"
            f"版B 原始 {d['plate_b_raw']:.3f} → 曲线后 {d['plate_b_after_curve']:.3f} → 终版 {d['plate_b_final']:.3f}｜"
            f"限墨系数 {d['limit_scale']:.3f}｜ΔE00 {d['de00_raw']:.2f}→{d['de00_final']:.2f}"
        )

    def _show_strip(self):
        strip, labels = make_check_strip(
            C.rgb_to_hex(self.inks.solid_a_rgb), C.rgb_to_hex(self.inks.solid_b_rgb),
            C.rgb_to_hex(self.inks.paper_rgb))
        self.panes["target"].set_rgb(strip)
        QMessageBox.information(self, "检查用例条", "顺序：" + " / ".join(labels))

    def _export(self):
        if self.result is None:
            QMessageBox.warning(self, "尚未完成", "请等待分色完成后再导出。")
            return
        out = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out:
            return
        try:
            paths = export_all(out, self.result, source_name=self.combo_source.currentText()[:8])
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", repr(exc))
            return
        QMessageBox.information(self, "导出完成",
                                "已写出：\n" + "\n".join(paths.values()))


def _luminance(rgb: np.ndarray) -> float:
    return float(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2])
