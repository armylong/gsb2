"""命令行入口：python -m greenscreen 启动 GUI。"""

from .app.main_window import run

if __name__ == "__main__":
    raise SystemExit(run())
