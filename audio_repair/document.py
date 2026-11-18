"""音频文档状态: 已确认数据、临时预览、撤销/重做历史与导出。

状态不变量
==========
- 已确认音频 (confirmed) 只会在 *提交预览*、*撤销*、*重做*、*恢复原文件*
  时改变; 调整参数产生的预览永远基于 confirmed 重新计算, 不会叠加。
- 预览是临时的: 取消即丢弃, confirmed 逐样本不变; 导出永远写 confirmed,
  绝不会把未确认预览写进成品。
- 所有数组保留原始采样率、声道数与长度。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import soundfile as sf
from PySide6.QtCore import QObject, Signal

from .processing import ProcessOptions, Selection, SelectionError, process_selection

MAX_HISTORY = 10
MAX_DURATION_S = 60.0
SUPPORTED_CHANNELS = (1, 2)


@dataclass
class PreviewState:
    audio: np.ndarray                  # 预览用的完整数组 (由 confirmed 处理得到)
    selection: Selection
    options: ProcessOptions
    context_start: int
    context_end: int
    label: str                         # 界面上明确标识 "未确认预览"


class AudioDocument(QObject):
    changed = Signal()                 # confirmed 发生变化 (提交/撤销/重做/恢复)
    preview_changed = Signal()         # 预览建立或取消
    message = Signal(str, str)         # (级别, 文本): info/warn/error

    def __init__(self, history_limit: int = MAX_HISTORY):
        super().__init__()
        self._path: str | None = None
        self._original: np.ndarray | None = None
        self._confirmed: np.ndarray | None = None
        self._sr: int = 0
        self._subtype: str | None = None
        self._undo: list[tuple[np.ndarray, str]] = []
        self._redo: list[tuple[np.ndarray, str]] = []
        self._preview: PreviewState | None = None
        self._history_limit = history_limit

    # ------------------------------------------------------------------ 属性
    @property
    def path(self) -> str | None:
        return self._path

    @property
    def sample_rate(self) -> int:
        return self._sr

    @property
    def n_samples(self) -> int:
        return 0 if self._confirmed is None else self._confirmed.shape[0]

    @property
    def n_channels(self) -> int:
        if self._confirmed is None:
            return 0
        return 1 if self._confirmed.ndim == 1 else self._confirmed.shape[1]

    @property
    def duration(self) -> float:
        return self.n_samples / self._sr if self._sr else 0.0

    @property
    def confirmed(self) -> np.ndarray | None:
        return self._confirmed

    @property
    def original(self) -> np.ndarray | None:
        return self._original

    @property
    def preview(self) -> PreviewState | None:
        return self._preview

    @property
    def working(self) -> np.ndarray | None:
        """界面展示/试听使用的数组: 有预览时为预览, 否则为已确认数据。"""
        if self._preview is not None:
            return self._preview.audio
        return self._confirmed

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    @property
    def has_preview(self) -> bool:
        return self._preview is not None

    def undo_label(self) -> str:
        return self._undo[-1][1] if self._undo else ""

    def redo_label(self) -> str:
        return self._redo[-1][1] if self._redo else ""

    # ------------------------------------------------------------------ 载入
    def load(self, path: str) -> None:
        info = sf.info(path)
        if info.channels not in SUPPORTED_CHANNELS:
            raise SelectionError(
                f"仅支持单声道或立体声 WAV, 文件声道数为 {info.channels}。"
            )
        if info.frames / info.samplerate > MAX_DURATION_S + 1e-9:
            raise SelectionError(
                f"音频时长 {info.frames / info.samplerate:.1f}s 超过 "
                f"{MAX_DURATION_S:.0f}s 限制, 请截取后再载入。"
            )
        data, sr = sf.read(path, always_2d=False, dtype="float64")
        if data.ndim == 2 and data.shape[1] not in SUPPORTED_CHANNELS:
            raise SelectionError("仅支持单声道或立体声 WAV。")
        self._path = os.path.abspath(path)
        self._sr = sr
        self._subtype = info.subtype
        self._original = data.copy()
        self._confirmed = data.copy()
        self._undo.clear()
        self._redo.clear()
        self._preview = None
        self.changed.emit()
        self.preview_changed.emit()

    def validate_selection(self, sel: Selection) -> Selection:
        if self._confirmed is None:
            raise SelectionError("尚未载入音频。")
        n = self.n_samples
        bad_ch = [c for c in sel.channels if c < 0 or c >= self.n_channels]
        if bad_ch:
            raise SelectionError(
                f"通道越界: {bad_ch}, 当前音频为 {self.n_channels} 声道。"
            )
        clamped = sel.clamp(n, self._sr)
        if clamped.is_empty:
            raise SelectionError(
                "选区为空或完全越界: 请框选非空的时间与频率范围。"
            )
        if (clamped.start_sample != sel.start_sample
                or clamped.end_sample != sel.end_sample
                or clamped.f0 != sel.f0 or clamped.f1 != sel.f1):
            self.message.emit(
                "warn", "选区部分越界, 已自动夹紧到音频有效范围。"
            )
        return clamped

    # ------------------------------------------------------------------ 预览
    def make_preview(self, sel: Selection, options: ProcessOptions,
                     context_ms: float = 300.0) -> PreviewState:
        """基于 confirmed 重新计算修复结果 (绝不基于旧预览叠加)。"""
        if self._confirmed is None:
            raise SelectionError("尚未载入音频。")
        sel = self.validate_selection(sel)
        processed = process_selection(
            self._confirmed, self._sr, sel, options
        )
        ctx = int(round(context_ms / 1000.0 * self._sr))
        c0 = max(0, sel.start_sample - ctx)
        c1 = min(self.n_samples, sel.end_sample + ctx)
        mode_name = "局部衰减" if options.mode == "attenuate" else "邻域修补"
        self._preview = PreviewState(
            audio=processed,
            selection=sel,
            options=options,
            context_start=c0,
            context_end=c1,
            label=f"未确认预览 · {mode_name} · 强度 {options.strength:.2f}",
        )
        self.preview_changed.emit()
        return self._preview

    def cancel_preview(self) -> None:
        """取消预览: 丢弃临时结果, confirmed 保持不变, 不留半次修改。"""
        if self._preview is None:
            return
        self._preview = None
        self.preview_changed.emit()
        self.message.emit("info", "已取消预览, 音频恢复到调整前的已确认状态。")

    def commit_preview(self) -> None:
        """确认当前预览: 压入撤销栈并成为新的 confirmed。"""
        if self._preview is None:
            return
        label = self._preview.label.replace("未确认预览 · ", "")
        self._push_history(f"修复: {label}")
        self._confirmed = self._preview.audio.copy()
        self._preview = None
        self.preview_changed.emit()
        self.changed.emit()
        self.message.emit("info", "处理已确认并写入修改历史。")

    # ------------------------------------------------------------------ 历史
    def _push_history(self, label: str) -> None:
        self._undo.append((self._confirmed.copy(), label))
        if len(self._undo) > self._history_limit:
            self._undo.pop(0)
        self._redo.clear()

    def undo(self) -> None:
        if not self._undo:
            return
        self._discard_preview_silently()
        prev, label = self._undo.pop()
        self._redo.append((self._confirmed.copy(), label))
        self._confirmed = prev
        self.changed.emit()
        self.message.emit("info", f"已撤销: {label}")

    def redo(self) -> None:
        if not self._redo:
            return
        self._discard_preview_silently()
        nxt, label = self._redo.pop()
        self._undo.append((self._confirmed.copy(), label))
        self._confirmed = nxt
        self.changed.emit()
        self.message.emit("info", f"已重做: {label}")

    def restore_original(self) -> None:
        """恢复原文件: 当前 confirmed 进撤销栈, 可再撤销回来。"""
        if self._original is None or self._confirmed is None:
            return
        self._discard_preview_silently()
        if np.array_equal(self._original, self._confirmed):
            self.message.emit("info", "当前状态与原文件一致, 无需恢复。")
            return
        self._push_history("恢复原文件")
        self._confirmed = self._original.copy()
        self.changed.emit()
        self.message.emit("info", "已恢复为原始文件内容 (可撤销)。")

    def _discard_preview_silently(self) -> None:
        if self._preview is not None:
            self._preview = None
            self.preview_changed.emit()

    # ------------------------------------------------------------------ 导出
    def export(self, path: str) -> None:
        """导出当前 *已确认* 状态; 存在未确认预览时只写 confirmed。"""
        if self._confirmed is None:
            raise SelectionError("没有可导出的音频。")
        data = self._confirmed
        subtype = self._subtype if self._subtype else "PCM_16"
        try:
            sf.write(path, data, self._sr, subtype=subtype)
        except Exception:
            # 某些 subtype 可能与容器不兼容, 回退到 16-bit PCM
            subtype = "PCM_16"
            sf.write(path, data, self._sr, subtype=subtype)
        note = ""
        if self.has_preview:
            note = "(注意: 未确认的临时预览未写入, 导出内容为上一次确认状态)"
        self.message.emit(
            "info",
            f"已导出 {os.path.basename(path)}: {self._sr} Hz, "
            f"{self.n_channels} 声道, {self.n_samples} 样本 {note}",
        )
