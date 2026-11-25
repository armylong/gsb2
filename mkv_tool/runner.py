from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any, Sequence


@dataclass
class CommandResult:
    args: list[str]
    returncode: int
    stdout: bytes
    stderr: bytes

    @property
    def stdout_text(self) -> str:
        return self.stdout.decode("utf-8", errors="replace")

    @property
    def stderr_text(self) -> str:
        return self.stderr.decode("utf-8", errors="replace")

    def stderr_tail(self, chars: int = 4000) -> str:
        text = self.stderr_text.strip()
        return text[-chars:] if len(text) > chars else text

    def json(self) -> Any:
        return json.loads(self.stdout_text)


def run_capture(args: Sequence[str], *, timeout: float | None = None) -> CommandResult:
    proc = subprocess.run(
        [str(a) for a in args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )
    return CommandResult(
        args=list(map(str, args)),
        returncode=proc.returncode,
        stdout=proc.stdout or b"",
        stderr=proc.stderr or b"",
    )
