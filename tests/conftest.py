"""Test configuration: keep Qt headless so tests run on CI without a display."""
from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
