"""Tiny local web viewer built only on the Python standard library.

Serves the static single-page UI and the exported ``lineage.json`` payload.
Everything runs on 127.0.0.1: no external services, no build step.
"""

from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer

WEB_DIR = Path(__file__).parent


class _LineageHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, payload_path: Path, **kwargs):
        self._payload_path = payload_path
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self.path in ("/api/lineage", "/api/lineage/"):
            self._serve_payload()
            return
        if self.path in ("/", "/index.html"):
            self.path = "/index.html"
        return super().do_GET()

    def _serve_payload(self) -> None:
        try:
            data = self._payload_path.read_bytes()
        except OSError as exc:
            self.send_error(404, f"lineage payload missing: {exc}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Quiet default logging; errors still surface via send_error.
        return


def serve(payload_path: str | Path, host: str = "127.0.0.1", port: int = 8000) -> None:
    payload_path = Path(payload_path).resolve()
    if not payload_path.exists():
        raise FileNotFoundError(f"export first; {payload_path} does not exist")

    handler = partial(_LineageHandler, payload_path=payload_path)
    with TCPServer((host, port), handler) as httpd:
        print(f"serving {payload_path.name} on http://{host}:{port}/ (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nserver stopped")
