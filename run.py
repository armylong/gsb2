#!/usr/bin/env python3
"""启动本地网页界面: http://127.0.0.1:8765"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn

if __name__ == "__main__":
    uvicorn.run("speedtool.server:app", host="127.0.0.1", port=8765, reload=False)
