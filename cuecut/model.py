"""Shared data types for the cue sheet / audio model.

All times coming out of the cue parser are ``Fraction`` seconds so that no
rounding ever happens before we convert to sample positions.  A sample position
is an integer index into the source WAV (0 .. total_samples-1).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction
from typing import List, Optional


@dataclass(frozen=True)
class Track:
    number: int
    title: str
    artist: str = ""
    # Mandatory INDEX 01 point: where the song proper starts.
    start: Fraction = Fraction(0)
    # Optional INDEX 00 point: lead-in / pre-gap start.  ``None`` means the
    # sheet has no explicit lead-in for this track (the audio between the
    # previous track's mandatory start and this one's start is still lead-in,
    # it is just not marked on the sheet).
    lead: Optional[Fraction] = None
    # Line numbers of the TRACK / INDEX 00 / INDEX 01 statements so validation
    # errors can point at the exact place in the sheet.
    source_line: int = 0
    start_line: int = 0
    lead_line: int = 0

    @property
    def display_start(self) -> Fraction:
        """First sample belonging to the sheet entry (including lead-in)."""
        return self.lead if self.lead is not None else self.start

    @property
    def has_explicit_lead(self) -> bool:
        return self.lead is not None


@dataclass(frozen=True)
class TrackError:
    line: int
    message: str
    track_number: Optional[int] = None
    code: str = "error"


@dataclass(frozen=True)
class Warning:
    line: int
    message: str


@dataclass
class CueSheet:
    filename: str
    title: str
    performer: str
    file_name: str = ""
    file_line: int = 0
    tracks: List[Track] = field(default_factory=list)
    # Parse problems found without looking at the audio.
    parse_errors: List[TrackError] = field(default_factory=list)
    parse_warnings: List["Warning"] = field(default_factory=list)
    # Currently effective problems (parse + audio validation).  Rebuilt
    # whenever a different WAV is loaded.
    errors: List[TrackError] = field(default_factory=list)
    warnings: List["Warning"] = field(default_factory=list)

    @property
    def blocking(self) -> bool:
        return bool(self.errors)

    def error_text(self) -> str:
        return "\n".join(
            (f"line {e.line}: " if e.line else "") + e.message for e in self.errors
        )


@dataclass(frozen=True)
class AudioInfo:
    path: str
    samplerate: int
    channels: int
    total_samples: int
    subtype: str

    @property
    def duration(self) -> Fraction:
        from fractions import Fraction

        return Fraction(self.total_samples, self.samplerate)


@dataclass(frozen=True)
class Segment:
    """One emitted file.

    ``first_sample`` / ``last_sample`` are inclusive.  ``sheet_index`` names
    the cue entry this segment belongs to (``-1`` for the very first lead-in
    when the user chooses to save it on its own).
    """

    first_sample: int
    last_sample: int
    sheet_index: int
    kind: str  # "track", "lead", "head_lead"
    label: str
    file_name: str = ""

    @property
    def sample_count(self) -> int:
        return self.last_sample - self.first_sample + 1
