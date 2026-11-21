"""QThread 工作线程：探测、代理预览生成、导出+校验、素材生成。"""
from __future__ import annotations

from PySide6.QtCore import QThread, Signal

from .ffutils import make_preview_proxy
from .pipeline import ExportOptions, export, verify_export
from .probe import probe
from .samples import generate_all


class ProbeThread(QThread):
    ok = Signal(object)
    failed = Signal(str)

    def __init__(self, path: str):
        super().__init__()
        self.path = path

    def run(self):
        try:
            self.ok.emit(probe(self.path))
        except Exception as exc:  # noqa: BLE001 - 送回 UI 线程展示
            self.failed.emit(str(exc))


class PreviewThread(QThread):
    ready = Signal(str, str)          # mode, proxy_path
    failed = Signal(str, str)         # mode, message

    def __init__(self, path: str, geometry, modes):
        super().__init__()
        self.path = path
        self.geometry = geometry
        self.modes = modes
        self._abort = False

    def request_abort(self):
        self._abort = True

    def run(self):
        for mode in self.modes:
            if self._abort:
                return
            try:
                proxy = make_preview_proxy(self.path, self.geometry, mode)
                if self._abort:
                    return
                self.ready.emit(mode, proxy)
            except Exception as exc:  # noqa: BLE001
                self.failed.emit(mode, str(exc))


class ExportThread(QThread):
    log_line = Signal(str)
    finished_ok = Signal(object, object)   # output_path, VerificationReport
    failed = Signal(str)

    def __init__(self, probe_result, opts: ExportOptions):
        super().__init__()
        self.probe_result = probe_result
        self.opts = opts

    def run(self):
        try:
            expected = self.probe_result.geometry.output_size(self.opts.even_policy)
            path = export(
                self.probe_result, self.opts, log=self.log_line.emit
            )
            report = verify_export(path, expected, self.probe_result.has_audio)
            self.finished_ok.emit(path, report)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))


class SamplesThread(QThread):
    progress = Signal(int, int, str)
    finished_ok = Signal(list)
    failed = Signal(str)

    def __init__(self, out_dir: str):
        super().__init__()
        self.out_dir = out_dir

    def run(self):
        try:
            paths = generate_all(
                self.out_dir,
                progress=lambda d, t, name: self.progress.emit(d, t, name),
            )
            self.finished_ok.emit(paths)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))
