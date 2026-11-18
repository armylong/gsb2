"""Cross-check an exported APNG with ffmpeg if it is installed.

This is an optional extra check: the test suite's primary verification uses
the independent reader in ``apng_editor.apng_codec``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


def ffprobe_info(path: Path) -> dict | None:
    if not shutil.which("ffprobe"):
        return None
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v",
            "-show_entries",
            "stream=codec_name,width,height,pix_fmt",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def count_with_ffmpeg(path: Path) -> int | None:
    if not shutil.which("ffprobe"):
        return None
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=nw=1:nk=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(result.stdout.strip())


def main(paths: list[str]) -> int:
    failures = 0
    for name in paths:
        path = Path(name)
        info = ffprobe_info(path)
        if info is None:
            print("ffprobe 未安装，跳过外部检查")
            return 0
        stream = info["streams"][0]
        frames = count_with_ffmpeg(path)
        print(
            f"{path.name}: codec={stream['codec_name']} "
            f"{stream['width']}×{stream['height']} "
            f"pix_fmt={stream['pix_fmt']} frames={frames}"
        )
        if stream["codec_name"] != "apng" or stream["pix_fmt"] != "rgba":
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
