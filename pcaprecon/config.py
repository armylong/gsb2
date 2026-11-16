"""Runtime configuration and processing limits."""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_REDACTION = "***REDACTED***"


@dataclass
class Config:
    """User configurable limits and behaviour switches.

    Limits are enforced explicitly: when one is exceeded the analysis
    raises :class:`~pcaprecon.errors.LimitExceeded` rather than dropping
    data.  ``allow_partial`` only changes how the CLI reacts to that.
    """

    max_file_size_bytes: int = 512 * 1024 * 1024
    max_memory_bytes: int = 256 * 1024 * 1024
    max_packets: int = 2_000_000
    max_sessions: int = 100_000
    # Keep raw frame bytes in the packet ledger (off by default; the
    # frame->file offset mapping is retained regardless).
    keep_frames: bool = False
    verify_checksums: bool = False
    mask_secrets: bool = True
    redaction_token: str = DEFAULT_REDACTION
    # When a limit is hit, still emit a report marked as aborted.
    allow_partial: bool = False

    @staticmethod
    def from_cli_args(ns) -> "Config":
        return Config(
            max_file_size_bytes=int(ns.max_file_mb * 1024 * 1024),
            max_memory_bytes=int(ns.max_memory_mb * 1024 * 1024),
            max_packets=ns.max_packets,
            max_sessions=ns.max_sessions,
            keep_frames=ns.keep_frames,
            verify_checksums=ns.verify_checksums,
            mask_secrets=not ns.show_secrets,
            allow_partial=ns.allow_partial,
        )
