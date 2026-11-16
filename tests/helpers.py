"""测试公共辅助：在后台线程启动本机测试服务，并构造最小配置。"""
from __future__ import annotations

import os
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from apifuzz.config import Config, Endpoint                    # noqa: E402
from testservice.server import create_server, reset_store     # noqa: E402


def start_test_server(port: int):
    server = create_server(port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/health", timeout=1):
                break
        except OSError:
            time.sleep(0.05)
    reset_store()
    return server


def make_config(port: int, endpoints, **overrides) -> Config:
    base = dict(
        base_url=f"http://127.0.0.1:{port}",
        allowed_hosts=["127.0.0.1", "localhost"],
        allowed_ports=[port],
        endpoints=endpoints,
        seed=42,
        max_requests=2000,
        max_concurrency=4,
        timeout_seconds=5.0,
        max_runtime_seconds=120.0,
        max_redirects=2,
        secret_fields=["password"],
    )
    base.update(overrides)
    return Config(**base)


def load_demo_endpoints():
    import json
    with open(os.path.join(ROOT, "configs", "demo.json"), encoding="utf-8") as fh:
        raw = json.load(fh)
    return [Endpoint.from_dict(e) for e in raw["endpoints"]]
