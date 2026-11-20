"""量化重算的后台工作线程。

Floyd-Steinberg 为逐像素循环，512px 图上可能耗时数百毫秒，
统一把「噪声 + 量化 + 分析」放到工作线程，GUI 仅负责展示结果。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QObject, QThread, Signal

from .analysis import (
    boundary_mask,
    boundary_transitions,
    error_map,
    error_stats,
    error_to_rgb,
    level_histogram,
)
from .quantize import add_noise, quantize


class ComputeWorker(QObject):
    """输入一组参数，输出完整分析结果；运行在独立 QThread 中。"""

    finished = Signal(dict)
    failed = Signal(str)

    def __init__(self, gray: np.ndarray, alpha: np.ndarray, levels: np.ndarray,
                 method: str, noise_strength: float, noise_seed: int,
                 bayer_order: int) -> None:
        super().__init__()
        self._args = (gray, alpha, levels, method, noise_strength, noise_seed, bayer_order)

    def run(self) -> None:
        try:
            gray, alpha, levels, method, strength, seed, bayer_order = self._args
            noisy = add_noise(gray, alpha, strength, seed)
            q = quantize(noisy, alpha, levels, method=method,
                         seed=seed, bayer_order=bayer_order)
            hist = level_histogram(q, alpha, levels)
            bmask = boundary_mask(q, alpha)
            transitions = boundary_transitions(q, alpha, levels, max_rows=16)
            err = error_map(noisy, q, alpha)
            stats = error_stats(err, alpha)
            err_rgb = error_to_rgb(err, alpha)
            self.finished.emit({
                "noisy": noisy,
                "q": q,
                "alpha": alpha,
                "hist": hist,
                "boundary": bmask,
                "transitions": transitions,
                "err": err,
                "err_rgb": err_rgb,
                "stats": stats,
            })
        except Exception as exc:  # 后台线程里的异常要送回主线程展示
            self.failed.emit(f"{type(exc).__name__}: {exc}")


def compute_async(gray, alpha, levels, method, strength, seed,
                  bayer_order) -> tuple[QThread, ComputeWorker]:
    """创建线程与 worker，返回 (thread, worker)，由调用方连接信号并 start。

    线程与 worker 的销毁完全交给 Python 引用计数（不设 parent、
    不在 finished 上挂 deleteLater），避免与主窗口侧的 self._thread
    引用产生 Qt/Python 双重所有权冲突。
    """
    thread = QThread()
    worker = ComputeWorker(gray, alpha, levels, method, strength, seed, bayer_order)
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    worker.finished.connect(thread.quit)
    worker.failed.connect(thread.quit)
    return thread, worker
