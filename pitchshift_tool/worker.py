"""后台移调线程: 可取消, 带进度, 结果与配置编号一起返回。"""

from __future__ import annotations

import traceback

import numpy as np
from PySide6.QtCore import QThread, Signal

from .pipeline import CancelToken, CancelledError, pitch_shift


class ProcessWorker(QThread):
    progress = Signal(int, float)        # config_id, 0..1
    succeeded = Signal(int, object, float)  # config_id, samples(np.ndarray), semitones
    failed = Signal(int, str)
    cancelled = Signal(int)

    def __init__(
        self, samples: np.ndarray, sr: int, semitones: float, config_id: int
    ) -> None:
        super().__init__()
        self._samples = samples
        self._sr = sr
        self._semitones = semitones
        self._config_id = config_id
        self.token = CancelToken()

    def run(self) -> None:
        try:
            out = pitch_shift(
                self._samples,
                self._sr,
                self._semitones,
                token=self.token,
                progress_cb=lambda p: self.progress.emit(self._config_id, float(p)),
            )
            if self.token.cancelled:
                self.cancelled.emit(self._config_id)
                return
            self.succeeded.emit(self._config_id, out, self._semitones)
        except CancelledError:
            self.cancelled.emit(self._config_id)
        except Exception as exc:  # 界面需要看到失败原因
            self.failed.emit(
                self._config_id, f"{exc}\n{traceback.format_exc(limit=2)}"
            )

    def request_cancel(self) -> None:
        self.token.cancel()
