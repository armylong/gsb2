"""Typed exceptions used across pcaprecon."""

from __future__ import annotations


class PcapReconError(Exception):
    """Base class for all pcaprecon errors."""


class CaptureFormatError(PcapReconError):
    """The capture file is not a supported pcap/pcapng file at all."""


class LimitExceeded(PcapReconError):
    """Raised when a configured file/memory/packet limit is reached.

    The tool stops explicitly instead of silently dropping packets.
    """

    def __init__(self, code: str, message: str, used: int = 0, limit: int = 0):
        super().__init__(message)
        self.code = code
        self.used = used
        self.limit = limit
        self.message = message


class MalformedCapture(PcapReconError):
    """A structural problem makes further parsing of the file unsafe."""
