"""帧提供器: 用 ffmpeg 解码三种视图的帧, 缓存为 QImage。

设计:
  - 预渲染在 QThread 里跑, 避免阻塞界面; 帧先落盘到临时目录 (无损 PNG),
    再按需加载进内存并做 LRU 缓存, 兼顾放大检查与内存占用;
  - 放大检查直接在全分辨率 QImage 上裁剪缩放, 不改输出尺寸;
  - 切换场序时启用全新「代次」缓存目录并重新预渲染; 旧场序的解码线程只写
    自己那一代目录, 不会把错误场序的帧污染到新结果。
"""
from __future__ import annotations

import tempfile
from collections import OrderedDict
from pathlib import Path

from PySide6.QtCore import QObject, QThread, Signal
from PySide6.QtGui import QImage

from .ffmpeg_tools import decode_frames, frame_size, read_stderr_log
from .timing import Mode, Parity

MEM_CACHE_LIMIT = 48


class FrameProvider:
    """管理某个素材在某场序下三种模式的帧缓存。"""

    def __init__(self, src_path: str | Path, width: int, height: int):
        self.src_path = Path(src_path)
        self.width = width
        self.height = height
        self._root = Path(tempfile.mkdtemp(prefix="dlab_frames_"))
        self._tmpdir = self._root / "gen0"
        self._tmpdir.mkdir(parents=True, exist_ok=True)
        self._mem: dict[tuple[Mode, int], QImage] = OrderedDict()
        # 已落盘的最大帧号 +1; 未开始预渲染的模式为 0。
        self._on_disk: dict[Mode, int] = {}
        self._total: dict[Mode, int] = {}

    def new_generation(self) -> None:
        """切换场序时启用全新缓存目录, 旧线程只写旧目录, 不会污染新结果。"""
        import shutil
        old = self._tmpdir
        gen = int(old.name.replace("gen", "")) + 1
        self._tmpdir = self._root / f"gen{gen}"
        self._tmpdir.mkdir(parents=True, exist_ok=True)
        self._mem.clear()
        self._on_disk.clear()
        # 旧代次目录可能仍被一个即将结束的线程持有, 尽力清理, 失败留给 cleanup。
        shutil.rmtree(old, ignore_errors=True)

    def set_total(self, mode: Mode, count: int) -> None:
        self._total[mode] = count

    def cache_path(self, mode: Mode, index: int) -> Path:
        return self._tmpdir / f"{mode}_{index:06d}.png"

    # ---- 预渲染 (工作线程内调用) ----
    def prerender(self, mode: Mode, parity: Parity, progress_cb=None,
                  cancel_cb=None, process_holder=None) -> int:
        """整段解码并落盘, 返回写出的帧数。raw 模式忽略 parity。

        进入时绑定当前代次目录: 即便之后切换场序触发 new_generation(),
        本线程 (旧场序) 仍只写自己那一代目录, 不会污染新结果。

        process_holder: 可选的可变对象, 解码进程会挂到其 .process 属性,
        供外部在取消/关闭时主动 terminate (cancel 标志只在帧间被检查)。
        解码出错 (0 帧) 时抛出带 ffmpeg stderr 的异常, 绝不静默失败。
        """
        total = self._total.get(mode)
        gen_dir = self._tmpdir
        proc, stderr_path = decode_frames(self.src_path, mode, parity)
        if process_holder is not None:
            process_holder.process = proc
        assert proc.stdout is not None
        fsize = frame_size(self.width, self.height, "rgb24")
        index = 0
        cancelled = False
        try:
            while True:
                if cancel_cb is not None and cancel_cb():
                    cancelled = True
                    break
                raw = proc.stdout.read(fsize)
                if len(raw) < fsize:
                    break
                img = QImage(raw, self.width, self.height,
                             self.width * 3, QImage.Format.Format_RGB888).copy()
                img.save(str(gen_dir / f"{mode}_{index:06d}.png"), "PNG")
                index += 1
                if progress_cb is not None and total:
                    progress_cb(min(index / total, 1.0))
        finally:
            if proc.stdout:
                proc.stdout.close()
            if cancelled and proc.poll() is None:
                proc.terminate()
            proc.wait()
            if process_holder is not None:
                process_holder.process = None
            err = read_stderr_log(stderr_path)
            try:
                stderr_path.unlink(missing_ok=True)
            except OSError:
                pass
        # 只有仍属于当前代次时才更新落盘计数, 避免旧线程干扰新代次状态。
        if gen_dir == self._tmpdir:
            self._on_disk[mode] = index
        if index == 0 and not cancelled:
            raise RuntimeError(
                f"ffmpeg 没有输出任何帧 (模式 {mode}, 场序 {parity})。\n{err or '未知错误'}"
            )
        return index

    def is_ready(self, mode: Mode) -> bool:
        return self._on_disk.get(mode, 0) >= self._total.get(mode, 1 << 30) and self._total.get(mode, 0) > 0

    def progress_of(self, mode: Mode) -> float:
        total = self._total.get(mode, 0)
        if not total:
            return 0.0
        return min(self._on_disk.get(mode, 0) / total, 1.0)

    # ---- 取帧 (界面线程) ----
    def get_frame(self, mode: Mode, index: int) -> QImage | None:
        key = (mode, index)
        if key in self._mem:
            self._mem.move_to_end(key)
            return self._mem[key]
        path = self.cache_path(mode, index)
        if not path.exists():
            return None
        img = QImage(str(path))
        if img.isNull():
            return None
        self._mem[key] = img
        self._mem.move_to_end(key)
        while len(self._mem) > MEM_CACHE_LIMIT:
            self._mem.popitem(last=False)
        return img

    def invalidate(self, modes: list[Mode]) -> None:
        """切换场序: 启用新一代缓存目录 (raw 也会随代次重建, 保证一致)。"""
        self.new_generation()

    def cleanup(self) -> None:
        import shutil
        shutil.rmtree(self._root, ignore_errors=True)


class PrerenderWorker(QObject):
    """在独立线程预渲染一个模式。"""

    progress = Signal(str, float)
    finished = Signal(str, int)
    failed = Signal(str, str)

    def __init__(self, provider: FrameProvider, mode: Mode, parity: Parity):
        super().__init__()
        self.provider = provider
        self.mode = mode
        self.parity = parity
        self._cancel = False
        self.process = None  # 当前 ffmpeg 子进程, 由 prerender 挂上来

    def cancel(self) -> None:
        """请求取消; 若正阻塞在读帧, 直接终止 ffmpeg 让读循环立即返回。"""
        self._cancel = True
        proc = self.process
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass

    def run(self) -> None:
        try:
            n = self.provider.prerender(
                self.mode,
                self.parity,
                progress_cb=lambda p: self.progress.emit(self.mode, p),
                cancel_cb=lambda: self._cancel,
                process_holder=self,
            )
            if self._cancel:
                # 被取消的一轮不算成功, 不发 finished, 由新代次接管。
                return
            self.finished.emit(self.mode, n)
        except Exception as exc:  # noqa: BLE001 - 送到界面展示
            if self._cancel:
                return
            self.failed.emit(self.mode, str(exc))


def start_prerender(worker: PrerenderWorker) -> QThread:
    thread = QThread()
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    worker.finished.connect(thread.quit)
    worker.failed.connect(thread.quit)
    thread.finished.connect(thread.deleteLater)
    thread.start()
    return thread
