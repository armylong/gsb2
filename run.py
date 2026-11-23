#!/usr/bin/env python3
"""Launcher: ``python run.py`` starts the desktop app."""

from __future__ import annotations

import sys

from subtitle_tool.gui.app import main

if __name__ == "__main__":
    sys.exit(main())
