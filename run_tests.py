#!/usr/bin/env python3
"""Test runner usable under ``python3 -I`` (no site-packages/cwd on path)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    loader = unittest.TestLoader()
    import importlib
    test_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "pcaprecon", "tests")
    names = [f[:-3] for f in os.listdir(test_dir)
             if f.startswith("test_") and f.endswith(".py")]
    suite = unittest.TestSuite()
    for name in sorted(names):
        module = importlib.import_module(f"pcaprecon.tests.{name}")
        suite.addTests(loader.loadTestsFromModule(module))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
