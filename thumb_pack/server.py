"""Loopback-only local server with Range support for source-video seeking."""

from __future__ import annotations

import json
import mimetypes
import os
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


class PackHandler(SimpleHTTPRequestHandler):
    pack_root: Path = Path(".")
    video_path: Path | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(self.pack_root), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep the terminal readable; caller can still see errors via checks.
        if os.environ.get("THUMB_PACK_HTTP_VERBOSE"):
            super().log_message(fmt, *args)

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        parsed = urlparse(self.path)
        if parsed.path == "/__thumb_pack/config.json":
            self._send_json(self._config())
            return
        if parsed.path == "/__thumb_pack/video":
            self._send_video()
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/__thumb_pack/config.json":
            self._send_json(self._config(), head=True)
            return
        if parsed.path == "/__thumb_pack/video":
            self._send_video(head=True)
            return
        super().do_HEAD()

    def _config(self) -> dict[str, Any]:
        return {
            "manifest": "manifest.json",
            "video": str(self.video_path) if self.video_path else None,
            "videoUrl": "/__thumb_pack/video" if self.video_path and self.video_path.exists() else None,
        }

    def _send_json(self, payload: dict[str, Any], head: bool = False) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _send_video(self, head: bool = False) -> None:
        path = self.video_path
        if path is None or not path.exists() or not path.is_file():
            body = b"video not configured or not found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return

        size = path.stat().st_size
        ctype = mimetypes.guess_type(str(path))[0] or "video/mp4"
        range_header = self.headers.get("Range")
        start = 0
        end = size - 1
        status = 200
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
            if match:
                a, b = match.groups()
                if a:
                    start = int(a)
                    if b:
                        end = int(b)
                elif b:
                    suffix = int(b)
                    start = max(0, size - suffix)
                end = min(end, size - 1)
                if start >= size or end < start:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return

        with path.open("rb") as fh:
            fh.seek(start)
            remaining = length
            chunk_size = 1024 * 1024
            while remaining > 0:
                chunk = fh.read(min(chunk_size, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    return
                remaining -= len(chunk)


def serve_pack(
    pack_dir: str | Path,
    video: str | Path | None = None,
    host: str = "127.0.0.1",
    port: int = 8765,
    open_browser: bool = True,
) -> tuple[ThreadingHTTPServer, str]:
    root = Path(pack_dir).expanduser().resolve()
    if not (root / "manifest.json").exists():
        raise FileNotFoundError(f"{root} does not contain manifest.json")
    video_path = Path(video).expanduser().resolve() if video else None
    handler_cls = type(
        "ConfiguredPackHandler",
        (PackHandler,),
        {"pack_root": root, "video_path": video_path},
    )
    # The partial keeps the constructor compatible with ThreadingHTTPServer.
    handler = partial(handler_cls)  # type: ignore[arg-type]
    server = ThreadingHTTPServer((host, port), handler)
    actual_port = server.server_address[1]
    url = f"http://{host}:{actual_port}/viewer.html"
    if open_browser:
        try:
            import webbrowser

            webbrowser.open(url)
        except Exception:
            pass
    return server, url
