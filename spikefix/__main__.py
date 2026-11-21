"""python -m spikefix 入口: 启动图形界面, 或运行无界面自检."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="spikefix", description="数字录音孤立跳点修复工具")
    ap.add_argument("wav", nargs="?", help="启动后自动打开的 WAV 文件")
    ap.add_argument("--benchmark", action="store_true", help="只运行合成对照测试并退出")
    ap.add_argument("--json", action="store_true", help="基准测试输出 JSON")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)
    if args.benchmark:
        from .benchmark import main as bench_main
        bench_argv = ["--seed", str(args.seed)]
        if args.json:
            bench_argv.append("--json")
        return bench_main(bench_argv)
    from .gui.main_window import MainWindow
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication(sys.argv[:1])
    win = MainWindow()
    if args.wav:
        from .wavio import load_wav
        wav = load_wav(args.wav)
        win._set_project_data(wav, args.wav, path=args.wav, backup=wav)
        win.run_detection(verbose=False)
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
