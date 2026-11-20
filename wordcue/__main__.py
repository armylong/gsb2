"""程序入口: ``python -m wordcue``."""

from __future__ import annotations

import argparse
import os
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="wordcue",
        description="本地朗读逐词打轴工具: 给文本和音频手工标注词的时间, "
                    "导出可重开的项目包与带高亮的短视频。")
    parser.add_argument("project", nargs="?", help="要打开的 .json 项目")
    parser.add_argument("--sample", action="store_true",
                        help="启动时直接生成并载入内置样例")
    parser.add_argument("--dump-sample", metavar="DIR",
                        help="只生成样例 (音频 + 项目 JSON) 到目录, 不开界面")
    parser.add_argument("--self-check", action="store_true",
                        help="运行无界面自检 (模型/边界/导出), 退出码 0 表示通过")
    parser.add_argument("--self-check-no-video", action="store_true",
                        help="自检时跳过视频导出 (不依赖 ffmpeg)")
    parser.add_argument("--version", action="version", version="wordcue 0.1.0")
    args = parser.parse_args(argv)

    if args.self_check or args.self_check_no_video:
        from .selfcheck import run

        return run(with_video=not args.self_check_no_video)

    if args.dump_sample:
        from .sample import build_sample

        timeline = build_sample(args.dump_sample)
        project = os.path.join(args.dump_sample, "timeline.json")
        timeline.save(project)
        print(f"音频: {timeline.audio_path}")
        print(f"项目: {project}")
        print(f"词数: {len(timeline.cues)}  时长: {timeline.duration} ms")
        return 0

    from PySide6.QtWidgets import QApplication

    from .main_window import MainWindow

    app = QApplication(sys.argv[:1])
    app.setApplicationName("wordcue")
    app.setApplicationDisplayName("wordcue")
    app.setStyle("Fusion")
    from .main_window import STYLE

    app.setStyleSheet(STYLE)
    win = MainWindow()
    win.show()
    if args.sample:
        win.on_sample()
    elif args.project:
        _open_on_start(win, args.project)
    return app.exec()


def _open_on_start(win, path: str) -> None:
    from .model import Timeline

    try:
        timeline = Timeline.load(path)
    except (OSError, ValueError) as exc:
        win._status(f"无法打开 {path}: {exc}")
        return
    from .audio import AudioError

    audio = timeline.audio_path
    if audio and not os.path.isabs(audio):
        audio = os.path.join(os.path.dirname(os.path.abspath(path)), audio)
    peaks = None
    if audio and os.path.exists(audio):
        try:
            win.player.load(audio)
            peaks = win.player.peaks
            timeline.audio_path = audio
            timeline.duration = win.player.duration_ms or timeline.duration
        except AudioError:
            pass
    win._load_timeline(timeline, peaks=peaks, path=path)


if __name__ == "__main__":
    raise SystemExit(main())
