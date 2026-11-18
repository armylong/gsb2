"""Test configuration: keep Qt headless."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
