"""pytest 共享夹具: 每个测试会话生成一套真实样例(不是 mock)。"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from proxy_check.ffmedia import probe
from proxy_check.samples import generate_sample_set, make_different_content


@pytest.fixture(scope="session")
def sample_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("samples")
    generate_sample_set(d)
    return d


@pytest.fixture(scope="session")
def paths(sample_dir) -> dict[str, Path]:
    return {
        "source": sample_dir / "source.mp4",
        "good": sample_dir / "proxy_good.mp4",
        "offset": sample_dir / "proxy_offset.mp4",
        "different": sample_dir / "proxy_different.mp4",
    }


@pytest.fixture(scope="session")
def source_info(paths):
    return probe(paths["source"])


@pytest.fixture()
def work_dir(tmp_path) -> Path:
    """每个测试独立的工作目录。"""
    return tmp_path


@pytest.fixture()
def truncated_proxy(paths, work_dir) -> Path:
    """截断的代理: 丢掉尾部 30 帧, 制造帧数不一致(少段)。

    用重编码而非 -c copy: stream copy 会保留末帧的原始时长标记,
    重编码得到干净的 270 帧 CFR 文件, 只改变帧数这一个变量。
    """
    out = work_dir / "truncated.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(paths["good"]),
        "-frames:v", "270", "-c:v", "libx264", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", str(out),
    ], check=True)
    return out


@pytest.fixture()
def replaced_source(paths, work_dir) -> Path:
    """另一份内容但同为 mp4/CFR 的"被替换原片"。"""
    out = work_dir / "replaced_source.mp4"
    make_different_content(out, width=960, height=540)
    return out


@pytest.fixture()
def sidecar_less_good_copy(paths, work_dir) -> Path:
    """正常代理的复制件但不带 sidecar: 内容正确, 关联缺失 => PENDING。"""
    dst = work_dir / "proxy_no_sidecar.mp4"
    shutil.copy2(paths["good"], dst)
    return dst
