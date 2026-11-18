"""C 扩展的延迟编译与加载，失败时静默回退纯 Python。"""

from __future__ import annotations

import ctypes
import os
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.join(_HERE, "_peakfollower.c")
_LIB = os.path.join(_HERE, "_peakfollower.so")

_lib = None


def _build() -> bool:
    cc = os.environ.get("CC", "clang")
    try:
        subprocess.run(
            [cc, "-O3", "-shared", "-fPIC", "-o", _LIB, _SRC, "-lm"],
            check=True, capture_output=True, timeout=120)
        return os.path.isfile(_LIB)
    except (OSError, subprocess.SubprocessError):
        return False


def get_lib():
    """返回已加载的 ctypes CDLL，不可用时返回 None。"""
    global _lib
    if _lib is not None:
        return _lib
    if not os.path.isfile(_LIB) and not _build():
        return None
    try:
        lib = ctypes.CDLL(_LIB)
        lib.peak_follower.restype = None
        lib.peak_follower.argtypes = [
            ctypes.POINTER(ctypes.c_double),  # det
            ctypes.POINTER(ctypes.c_double),  # out
            ctypes.c_long,                    # n
            ctypes.c_double,                  # a_att
            ctypes.c_double,                  # a_rel
            ctypes.c_long,                    # zero_limit
        ]
        _lib = lib
        return _lib
    except OSError:
        return None
