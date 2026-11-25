import os

# Keep GUI tests headless by default. A real desktop session can override this.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
