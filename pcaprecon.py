#!/usr/bin/env python3
"""Convenience launcher so pcaprecon runs under an isolated interpreter
(``python3 -I pcaprecon.py ...``) without an installed package.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pcaprecon.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
