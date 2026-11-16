#!/usr/bin/env python3
"""生成本工作台使用的本地样例复现包。

输出目录结构 (默认 ./samples):
  sample_pkg_a/        第一个复现包 (正常 + 含凭据/PII)
  sample_pkg_b/        第二个包 (相对 A: 修改/缺失/新增/顺序变化/重命名)
  sample_pkg_corrupt/  含损坏文件的包 (非法 UTF-8、截断 JSON、坏 zip 成员)
  sample_bad.zip       整个 zip 被截断, 用于整包失败恢复测试
  duplicate_pkg/       与 A 内容重复的包, 用于重复证据标识

样例全部为静态文本, 不含任何可执行脚本; 地址均保留段 (TEST-NET-1)。
"""

from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

REQUEST_A = """\
POST /api/v1/login HTTP/1.1
Host: 192.0.2.10:8443
User-Agent: reproduce-client/1.0
X-Request-ID: req-7f3a2c91e8b4
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZXIifQ.s9K2signature
Content-Type: application/json

{"username":"alice@example.test","password":"Sup3rS3cret!","trace_id":"req-7f3a2c91e8b4"}
"""

RESPONSE_A = """\
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req-7f3a2c91e8b4
Set-Cookie: session=abc123; HttpOnly

{"code":0,"user":"alice@example.test","phone":"13800138000","id_card":"110101199003077777"}
"""

LOG_A = """\
2026-11-15T08:30:01.123Z INFO 192.0.2.10 POST /api/v1/login request_id=req-7f3a2c91e8b4 user=alice
2026-11-15T08:30:01.455Z WARN 192.0.2.10 slow auth backend cost=312ms request_id=req-7f3a2c91e8b4
2026-11-15T08:30:02.001Z INFO 192.0.2.20 GET /api/v1/profile 200 trace_id=req-7f3a2c91e8b4
2026-11-15T08:31:10.888Z ERROR 192.0.2.10 SQL syntax error near '' OR 1=1 --' incident_id=INC-2026-0007
"""

CONFIG_A = """\
[server]
host = 192.0.2.10
port = 8443
debug = false

[database]
password = db-root-pw-123456
endpoint = db.internal.test:3306
"""

NOTE_A = """\
# 复现说明 A

## 环境
- 目标: 测试环境登录接口 (保留地址段 192.0.2.0/24)
- 编号: CVE-2026-1234

## 备注
本说明仅用于静态整理演示, 不包含任何执行步骤。
"""

# B 包: 请求被修改 (参数变化), 日志顺序变化, 配置缺失, 新增文件, 说明被重命名
REQUEST_B = REQUEST_A.replace(
    '"password":"Sup3rS3cret!"', '"password":"An0therP@ss!"'
).replace("/api/v1/login", "/api/v1/login?debug=true")

RESPONSE_B = RESPONSE_A  # 响应不变

LOG_B_LINES = LOG_A.splitlines(keepends=True)
LOG_B = "".join([LOG_B_LINES[2], LOG_B_LINES[0], LOG_B_LINES[1], LOG_B_LINES[3]])

EXTRA_B = """\
GET /api/v1/health HTTP/1.1
Host: 192.0.2.10:8443
X-Request-ID: req-99aa11bb22cc

"""


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build_pkg_a(root: Path) -> None:
    write_text(root / "requests" / "login.http", REQUEST_A)
    write_text(root / "responses" / "login.resp", RESPONSE_A)
    write_text(root / "logs" / "app.log", LOG_A)
    write_text(root / "configs" / "app.ini", CONFIG_A)
    write_text(root / "README.md", NOTE_A)


def build_pkg_b(root: Path) -> None:
    # 顺序: 与 A 的目录排列顺序不同
    write_text(root / "01-probe" / "health.http", EXTRA_B)
    write_text(root / "02-login" / "login.http", REQUEST_B)
    write_text(root / "02-login" / "login.resp", RESPONSE_B)
    write_text(root / "03-logs" / "app.log", LOG_B)
    # configs/app.ini 在 B 中缺失
    write_text(root / "04-notes" / "manual.md", NOTE_A)  # 内容相同, 路径变化


def build_corrupt(root: Path) -> None:
    write_text(root / "ok" / "good.http", REQUEST_A)
    write_text(root / "ok" / "good.log", LOG_A)
    # 非法 UTF-8 字节
    (root / "broken" / "bad_utf8.log").parent.mkdir(parents=True, exist_ok=True)
    (root / "broken" / "bad_utf8.log").write_bytes(
        b"2026-11-15 INFO ok\n\xff\xfe\x00garbage line\n")
    # 截断的 JSON
    write_text(root / "broken" / "truncated.json",
               '{"level":"ERROR","message":"unterminated')
    # 二进制
    (root / "broken" / "blob.bin").write_bytes(bytes(range(256)) * 4)
    # zip slip 攻击命名 (仅在生成 zip 时使用, 目录包中用普通名字)
    write_text(root / "broken" / "empty.txt", "")


def build_duplicate(root: Path) -> None:
    # 与 A 完全相同的内容, 不同包名
    write_text(root / "requests" / "login.http", REQUEST_A)
    write_text(root / "logs" / "app.log", LOG_A)


def build_bad_zip(path: Path) -> None:
    """先写一个合法 zip 再截断尾部, 模拟下载不完整。"""
    tmp = path.with_suffix(".full.zip")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("requests/login.http", REQUEST_A)
        zf.writestr("logs/app.log", LOG_A)
    raw = tmp.read_bytes()
    path.write_bytes(raw[: int(len(raw) * 0.6)])  # 砍掉中央目录
    tmp.unlink()


def build_corrupt_zip(path: Path) -> None:
    """含非法成员名与损坏 CRC 成员的 zip。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("ok/good.http", REQUEST_A)
        zf.writestr("../escape.txt", "zip slip attempt")
        zf.writestr("/absolute/path.txt", "absolute path attempt")
        zf.writestr("broken/truncated.json",
                    '{"level":"ERROR","message":"unterminated')


def main() -> None:
    parser = argparse.ArgumentParser(description="生成工作台本地样例")
    parser.add_argument("--out", default="samples", help="输出目录")
    args = parser.parse_args()
    base = Path(args.out).resolve()
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True)

    build_pkg_a(base / "sample_pkg_a")
    build_pkg_b(base / "sample_pkg_b")
    build_corrupt(base / "sample_pkg_corrupt")
    build_duplicate(base / "duplicate_pkg")
    build_bad_zip(base / "sample_bad.zip")
    build_corrupt_zip(base / "sample_corrupt.zip")

    print(f"样例已生成到: {base}")
    for p in sorted(base.rglob("*")):
        if p.is_file():
            print(f"  {p.relative_to(base)} ({p.stat().st_size} B)")


if __name__ == "__main__":
    main()
