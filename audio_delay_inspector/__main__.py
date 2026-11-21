"""支持 ``python -m audio_delay_inspector`` 直接启动 GUI。"""

from .gui import main

if __name__ == "__main__":
    raise SystemExit(main())
