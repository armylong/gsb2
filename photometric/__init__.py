"""Photometric stereo workbench.

Local, offline tool that recovers per-pixel surface normals and base
reflectance from a stack of grayscale photographs of one static object lit
from different directions.

The package is intentionally dependency-light: numpy for the maths and
PySide6 for the interface.  Built-in scenes are synthesised procedurally.
"""

__version__ = "1.0.0"
APP_NAME = "光度立体 · 表面朝向工作台"
