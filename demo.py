#!/usr/bin/env python3
"""一条命令的完整演示：启动本机测试服务 -> 模糊测试 -> 重放验证。

不访问任何真实外部网站：测试服务只监听 127.0.0.1，工具的主机/端口
白名单也只包含本机端口；跳转到 example.invalid 会在发出请求前被拦截。

端口动态选择（默认从 8765 起找空闲端口），也可通过环境变量
APIFUZZ_DEMO_PORT 指定；配置以 configs/demo.json 为模板，运行时
注入实际 base_url / allowed_ports，写到临时文件后执行。
"""
from __future__ import annotations

import copy
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from apifuzz.config import Config, load_config              # noqa: E402
from apifuzz.engine import run                              # noqa: E402
from apifuzz.replay import replay_all                       # noqa: E402
from apifuzz.report import build_report, write_report       # noqa: E402
from testservice.server import create_server, reset_store   # noqa: E402

TEMPLATE_CONFIG = os.path.join(ROOT, "configs", "demo.json")
OUT_DIR = os.path.join(ROOT, "reports")


def pick_free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("8765-8814 区间没有可用端口")


def wait_healthy(port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/health", timeout=1) as resp:
                if resp.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("测试服务未在预期时间内启动")


def materialize_config(template_path: str, port: int) -> tuple:
    with open(template_path, encoding="utf-8") as fh:
        raw = json.load(fh)
    raw["base_url"] = f"http://127.0.0.1:{port}"
    raw["allowed_ports"] = [port]
    cfg = Config.from_dict(raw)
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix="apifuzz_demo_",
        dir=tempfile.gettempdir(), delete=False, encoding="utf-8")
    json.dump(raw, tmp, ensure_ascii=False, indent=2)
    tmp.close()
    return cfg, tmp.name


def main() -> int:
    preferred = int(os.environ.get("APIFUZZ_DEMO_PORT", "8765"))
    port = pick_free_port(preferred)
    server = create_server(port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    tmp_config = None
    try:
        wait_healthy(port)
        reset_store()
        print(f"[1/4] 本机测试服务已启动: http://127.0.0.1:{port}（仅监听 127.0.0.1）")

        cfg, tmp_config = materialize_config(TEMPLATE_CONFIG, port)
        print(f"[2/4] 开始模糊测试: seed={cfg.seed}, "
              f"请求上限={cfg.max_requests}, 并发上限={cfg.max_concurrency}, "
              f"白名单={sorted(cfg.allowed_hosts)}:{cfg.allowed_ports}")
        result = run(cfg, reduce=True)
        report = build_report(result)
        paths = write_report(report, OUT_DIR)

        print(f"[3/4] 报告已写入:\n      {paths['json']}\n      {paths['markdown']}")
        summary = report["summary"]
        print(f"      用例 {summary['total']} 条；判定分布 {summary['by_verdict']}")
        print(f"      失败分组 {summary['group_count']} 个；"
              f"实际请求 {report['limits_usage']['requests_used']} 次，"
              f"耗时 {report['limits_usage']['elapsed_seconds']}s")
        for group in report["groups"]:
            line = (f"      - {group['group_id']} {group['verdict']} "
                    f"{group['endpoint']} 成员={group['member_count']} "
                    f"fp={group['fingerprint']}")
            if "reduction" in group:
                red = group["reduction"]
                line += (f" 缩减尝试={red['trials_total']}"
                         f"(接受{red['trials_accepted']}/拒绝{red['trials_rejected']}"
                         f"/无法判断{red['trials_inconclusive']}) "
                         f"仍复现={red['reproduced']}")
            print(line)

        print("[4/4] 使用记录的环境准备步骤重放全部失败分组:")
        outcomes = replay_all(cfg, report)
        label = {"REPRODUCED": "仍可复现", "NOT_REPRODUCED": "未复现",
                 "UNKNOWN": "无法判断"}
        for outcome in outcomes:
            print(f"      [{label[outcome.verdict]}] {outcome.group_id} "
                  f"{outcome.endpoint}: {outcome.reason}")

        scope_blocked = [p for p in report.get("scope_probes", [])
                         if p["scope_blocked"]]
        scope_total = len(report.get("scope_probes", []))
        print(f"[范围限制] 范围探测 {len(scope_blocked)}/{scope_total} 条被拦截"
              f"（含服务端跳转越界，未发出任何范围外请求）")
        for probe in report.get("scope_probes", []):
            mark = "拦截" if probe["scope_blocked"] else "放行(异常!)"
            print(f"      [{mark}] {probe['name']}: {probe['url']}")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        if tmp_config:
            try:
                os.unlink(tmp_config)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
