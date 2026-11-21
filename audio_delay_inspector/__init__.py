"""短音频片头片尾空白排查工具包。

模块划分:
- core: 纯逻辑层。生成样例、调用 ffprobe/ffmpeg、脉冲定位、延迟标记分析、报告生成。
- gui:  PySide6 界面层, 只负责展示与触发, 不承载判定逻辑。

子模块按需惰性导入, 避免 ``python -m audio_delay_inspector.core`` 时
包 __init__ 提前加载 core 触发 runpy 警告。
"""

_LAZY_EXPORTS = {
    "ToolDependencyError": "core",
    "MarkerInfo": "core",
    "DecodeResult": "core",
    "FileAnalysis": "core",
    "ensure_ffmpeg": "core",
    "generate_reference_wav": "core",
    "analyze_file": "core",
    "write_report": "core",
    "write_decodings": "core",
    "run_selftest": "core",
}

__all__ = list(_LAZY_EXPORTS)


def __getattr__(name: str):
    if name in _LAZY_EXPORTS:
        from importlib import import_module
        mod = import_module(f"{__name__}.{_LAZY_EXPORTS[name]}")
        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
