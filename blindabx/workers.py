"""后台音频处理线程: 首次全流程编码 + 开关切换时只重建播放缓冲。"""
from __future__ import annotations

import os
import tempfile

from PySide6.QtCore import QThread, Signal

from . import audio
from .audio import (
    BUILTIN_SAMPLES, EncodeSetting, ProcessedBundle, SourceInfo,
    full_process, rebuild_final, write_wav,
)


class ProcessWorker(QThread):
    progress = Signal(str)
    finishedBundle = Signal(object)
    failed = Signal(str)

    def __init__(self, mode: str, payload: dict, parent=None) -> None:
        super().__init__(parent)
        self._mode = mode       # "full" | "rebuild"
        self._payload = payload

    def run(self) -> None:
        try:
            if self._mode == "full":
                self._run_full()
            else:
                self._run_rebuild()
        except audio.AudioError as exc:
            self.failed.emit(str(exc))
        except Exception as exc:  # noqa: BLE001 - 线程内兜底, 防止静默崩溃
            self.failed.emit(f"未预期错误: {exc!r}")

    # ------------------------------------------------------------------ #
    def _run_full(self) -> None:
        p = self._payload
        workdir = tempfile.mkdtemp(prefix="blindabx_")
        if p["source_kind"] == "builtin":
            sr = 48000
            builder = BUILTIN_SAMPLES[p["source_key"]][1]
            buf = builder(sr)
            src_path = os.path.join(workdir, "builtin_ref.wav")
            write_wav(buf, sr, buf.shape[1], src_path)
            name = BUILTIN_SAMPLES[p["source_key"]][0]
        else:
            src_path = p["source_path"]
            name = os.path.basename(src_path)
        sr, ch = audio.probe_stream(src_path)
        info = SourceInfo(
            kind=p["source_kind"], name=name, path=src_path, sr=sr, ch=ch,
        )
        setting_a: EncodeSetting = p["setting_a"]
        setting_b: EncodeSetting = p["setting_b"]
        bundle = full_process(
            info, setting_a, setting_b, workdir,
            alignment=p["alignment"],
            loudness_match=p["loudness_match"],
            progress=self.progress.emit,
        )
        self.finishedBundle.emit(bundle)

    def _run_rebuild(self) -> None:
        bundle: ProcessedBundle = self._payload["bundle"]
        _, final, offsets, final_metrics, gains = rebuild_final(
            bundle.raw, bundle.sr, bundle.ch,
            self._payload["alignment"], self._payload["loudness_match"],
        )
        bundle.final = final
        bundle.offsets = offsets
        bundle.final_metrics = final_metrics
        bundle.gains = gains
        bundle.alignment = self._payload["alignment"]
        bundle.loudness_match = self._payload["loudness_match"]
        self.finishedBundle.emit(bundle)
