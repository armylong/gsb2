"""Tab 5 — export the result and read it back to verify the encoding."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QFileDialog, QHBoxLayout, QLabel, QLineEdit,
                               QPushButton, QTextEdit, QVBoxLayout, QWidget)

from .. import exporting, rendering, theme
from ..context import AppContext
from ..widgets.common import SectionTitle, StatCard
from ..widgets.imageview import ImageView


class ExportView(QWidget):
    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        self._last_paths: exporting.ExportPaths | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(10)

        header = QHBoxLayout()
        title = QLabel("导出与回读核对")
        title.setObjectName("Title")
        header.addWidget(title)
        header.addStretch(1)
        root.addLayout(header)

        row = QHBoxLayout()
        row.setSpacing(8)
        self.path_edit = QLineEdit(str(Path.home() / "photometric-normals"))
        row.addWidget(self.path_edit, 1)
        browse = QPushButton("选择目录…")
        browse.clicked.connect(self._browse)
        row.addWidget(browse)
        self.export_btn = QPushButton("导出法线图与无效区域")
        self.export_btn.setObjectName("Primary")
        self.export_btn.clicked.connect(self.export)
        row.addWidget(self.export_btn)
        self.readback_btn = QPushButton("回读核对")
        self.readback_btn.clicked.connect(self.read_back)
        row.addWidget(self.readback_btn)
        root.addLayout(row)

        body = QHBoxLayout()
        body.setSpacing(12)
        left = QVBoxLayout()
        left.setSpacing(6)
        self.preview = ImageView()
        self.preview.setMinimumSize(380, 380)
        self.preview.set_badge("导出的法线图")
        left.addWidget(self.preview, 1)
        self.preview_hint = QLabel("")
        self.preview_hint.setObjectName("Muted")
        self.preview_hint.setWordWrap(True)
        left.addWidget(self.preview_hint)
        body.addLayout(left, 1)

        side = QVBoxLayout()
        side.setSpacing(8)
        side.addWidget(SectionTitle("保存的文件"))
        self.file_labels: list[QLabel] = []
        for key in ("法线图", "有效区域掩码", "反照率", "清单 manifest"):
            row_lbl = QHBoxLayout()
            name = QLabel(key)
            name.setFixedWidth(110)
            row_lbl.addWidget(name)
            path = QLabel("—")
            path.setObjectName("Muted")
            path.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            row_lbl.addWidget(path, 1)
            self.file_labels.append(path)
            side.addLayout(row_lbl)

        side.addWidget(SectionTitle("回读核对结果"))
        self.cards = {
            "pixels": StatCard("核对像素数"),
            "error": StatCard("方向往返误差"),
            "mask": StatCard("掩码一致率"),
        }
        for card in self.cards.values():
            side.addWidget(card)
        self.report = QTextEdit()
        self.report.setReadOnly(True)
        self.report.setMinimumHeight(150)
        self.report.setStyleSheet(
            f"background:{theme.PANEL_ALT}; border:1px solid {theme.BORDER}; border-radius:6px;"
        )
        side.addWidget(self.report, 1)

        self.explain = QLabel(
            "编码约定：R = (nx+1)/2，G = (ny+1)/2（绿朝上），B = (nz+1)/2（蓝朝观察者）。"
            "掩码中白色像素表示法线可用。回读会重新解码 PNG，与内存中的估计逐像素比较，"
            "并检查 B 分量朝向，确保方向没有被翻转。")
        self.explain.setWordWrap(True)
        self.explain.setObjectName("Muted")
        side.addWidget(self.explain)

        side_host = QWidget()
        side_host.setLayout(side)
        side_host.setFixedWidth(360)
        body.addWidget(side_host)
        root.addLayout(body, 1)

        context.resultChanged.connect(self.refresh)
        context.sceneChanged.connect(self.refresh)

    # ------------------------------------------------------------------ ui
    def _browse(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "选择导出目录", self.path_edit.text())
        if directory:
            self.path_edit.setText(directory)

    def refresh(self) -> None:
        result = self.ctx.result
        if result is None:
            self.preview.set_image(None, "先运行一次估计")
            self._clear_files()
            return
        self.preview.set_image(rendering.overlay_invalid(rendering.normal_map_rgb(result), result))
        self.preview_hint.setText(
            f"{result.width}×{result.height} · 有效 {result.valid.sum():,} / "
            f"{int(result.object_mask.sum()):,} 个物体像素")

    def _clear_files(self) -> None:
        for label in self.file_labels:
            label.setText("—")

    # --------------------------------------------------------------- actions
    def export(self) -> None:
        result = self.ctx.result
        if result is None:
            self.report.setPlainText("还没有可导出的估计。先运行一次估计。")
            return
        directory = Path(self.path_edit.text()).expanduser()
        names = [spec.name for spec in self.ctx.specs()]
        stem = self.ctx.scene.key if self.ctx.scene else "result"
        extra = {
            "title": self.ctx.scene.title if self.ctx.scene else "",
            "builtin": bool(self.ctx.scene and self.ctx.scene.has_truth),
        }
        try:
            paths = exporting.export_result(result, directory, stem=stem,
                                            light_names=names, extra=extra)
        except OSError as exc:
            self.report.setPlainText(f"写入失败：{exc}")
            return
        self._last_paths = paths
        for label, path in zip(self.file_labels,
                               (paths.normal_map, paths.invalid_mask,
                                paths.albedo, paths.manifest)):
            label.setText(str(path.name))
            label.setToolTip(str(path))
        self.report.setPlainText(
            f"已写入 {paths.directory}\n\n"
            f"• {paths.normal_map.name}\n"
            f"• {paths.invalid_mask.name}\n"
            f"• {paths.albedo.name}\n"
            f"• {paths.manifest.name}\n\n"
            "点“回读核对”会重新打开这些文件并验证方向编码。")

    def read_back(self) -> None:
        result = self.ctx.result
        if result is None or self._last_paths is None:
            self.report.setPlainText("先导出一次，再进行回读核对。")
            return
        if not self._last_paths.manifest.exists():
            self.report.setPlainText("导出文件已不在原位置，请重新导出。")
            return
        report = exporting.read_back_against(result, self._last_paths)
        self.cards["pixels"].set_value(f"{report.checked_pixels:,}")
        self.cards["error"].set_value(f"{report.mean_error_deg:.3f}°",
                                      f"最大 {report.max_error_deg:.3f}°",
                                      theme.OK if report.ok else theme.WARN)
        self.cards["mask"].set_value(f"{report.mask_agreement * 100:.2f}%")
        lines = [f"编码约定：{report.declared_encoding}", ""]
        lines.append("✅ 通过：" + report.summary() if report.ok else "❌ 未通过")
        if report.problems:
            lines.append("")
            for problem in report.problems:
                lines.append(f"• {problem}")
        self.report.setPlainText("\n".join(lines))
