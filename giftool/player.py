"""Frame timing and playback position logic (Qt-independent).

Two timing concepts are kept separate on purpose:

* **stored duration** — the centisecond-rounded value found in the GIF file;
* **effective duration** — what the player actually uses.  The GIF spec only
  resolves durations in hundredths of a second and historically treats very
  small values (0–15 ms) as "as fast as possible", which varies by machine.
  This tool publishes one uniform rule instead: any stored duration below
  :data:`MIN_PLAYABLE_MS` is played as :data:`SHORT_FRAME_MS`.

Looping follows the Netscape extension convention: ``loop == 0`` means loop
forever; ``loop == n`` (n >= 1) means *n* additional repetitions after the
first play-through, i.e. n + 1 total plays.  A file without the extension is
played exactly once.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Stored durations strictly below this are considered "too short to schedule".
MIN_PLAYABLE_MS = 20
#: Uniform playback duration applied to such short frames.
SHORT_FRAME_MS = 100


def effective_duration_ms(stored_ms: int) -> int:
    """Apply the published short-frame rule to one stored duration."""
    if stored_ms < MIN_PLAYABLE_MS:
        return SHORT_FRAME_MS
    return stored_ms


@dataclass
class Timeline:
    """Resolved timing information for a parsed animation."""

    stored_durations_ms: list[int]
    loop_count: int  # 0 == infinite; otherwise number of *additional* loops

    @property
    def effective_durations_ms(self) -> list[int]:
        return [effective_duration_ms(d) for d in self.stored_durations_ms]

    @property
    def frame_count(self) -> int:
        return len(self.stored_durations_ms)

    @property
    def is_infinite(self) -> bool:
        return self.loop_count == 0

    @property
    def total_plays(self) -> int:
        """Number of full play-throughs (infinite loops report 0)."""
        return 0 if self.is_infinite else self.loop_count + 1

    @property
    def one_pass_duration_ms(self) -> int:
        return sum(self.effective_durations_ms)


class PlaybackScheduler:
    """State machine mapping elapsed time to a frame position.

    The class knows nothing about QTimer: the UI layer drives it with
    monotonically increasing timestamps (a clock injection point that tests
    replace with a fake clock).  Every decision is derived from the current
    generation token and timeline, so a timer event that arrives after a pause
    or seek simply computes the position from scratch — there is no queued
    "advance one frame" action that could fire late.
    """

    def __init__(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self._generation = 0
        self._playing = False
        self._frame = 0
        self._play_index = 0  # which full play-through we are on
        self._start_ms = 0  # clock time at which the current play-through began
        self._pause_frame_ms = 0  # offset within play-through at last pause

    # -- generation / invalidation ---------------------------------------

    def _bump_generation(self) -> None:
        self._generation += 1

    @property
    def generation(self) -> int:
        """Opaque token; stale UI callbacks compare against this value."""
        return self._generation

    # -- transport --------------------------------------------------------

    def play(self, now_ms: int) -> None:
        if self._playing:
            return
        self._playing = True
        self._start_ms = now_ms - self._pause_frame_ms
        self._bump_generation()

    def pause(self) -> None:
        if not self._playing:
            return
        self._playing = False
        self._bump_generation()

    @property
    def is_playing(self) -> bool:
        return self._playing

    def stop_and_reset(self) -> None:
        """Full stop back to frame 0 (used when closing/reopening a file)."""
        self._playing = False
        self._frame = 0
        self._play_index = 0
        self._pause_frame_ms = 0
        self._bump_generation()

    def seek_to_frame(self, frame: int) -> None:
        """Jump to an explicit frame, from any position, including backwards."""
        frame = max(0, min(frame, self.timeline.frame_count - 1))
        self._frame = frame
        self._pause_frame_ms = sum(
            self.timeline.effective_durations_ms[:frame]
        )
        # A manual seek restarts the current play-through at this offset.
        self._bump_generation()

    def step_forward(self) -> int:
        if self._frame < self.timeline.frame_count - 1:
            self.seek_to_frame(self._frame + 1)
        return self._frame

    def step_backward(self) -> int:
        """Backward stepping never wraps into a previous loop."""
        if self._frame > 0:
            self.seek_to_frame(self._frame - 1)
        return self._frame

    # -- clock integration ------------------------------------------------

    def frame_due_at(self) -> int:
        """Absolute clock time at which the next frame boundary occurs."""
        if not self._playing:
            msg = "frame_due_at is only valid while playing"
            raise RuntimeError(msg)
        offset = sum(
            self.timeline.effective_durations_ms[: self._frame + 1]
        )
        return self._start_ms + offset

    def update(self, now_ms: int) -> tuple[int, bool]:
        """Recompute position from a clock reading.

        Returns ``(frame_index, finished)``.  ``finished`` is True when a
        finite animation has exhausted all play-throughs; the scheduler pauses
        itself and holds the last frame.  Safe to call with "late" timestamps:
        the result depends only on ``now_ms`` and the current generation.
        """
        if not self._playing:
            return self._frame, False

        durations = self.timeline.effective_durations_ms
        pass_ms = self.timeline.one_pass_duration_ms
        elapsed = now_ms - self._start_ms

        if not self.timeline.is_infinite:
            budget = pass_ms * self.timeline.total_plays
            if elapsed >= budget:
                self._playing = False
                self._frame = self.timeline.frame_count - 1
                self._play_index = self.timeline.total_plays - 1
                self._pause_frame_ms = sum(durations[: self._frame])
                self._bump_generation()
                return self._frame, True

        if pass_ms > 0:
            self._play_index = elapsed // pass_ms
            offset = elapsed % pass_ms
        else:
            self._play_index = 0
            offset = 0

        cumulative = 0
        new_frame = self.timeline.frame_count - 1
        for i, duration in enumerate(durations):
            if offset < cumulative + duration:
                new_frame = i
                break
            cumulative += duration
        if new_frame != self._frame:
            self._frame = new_frame
            self._bump_generation()
        return self._frame, False

    @property
    def frame_index(self) -> int:
        return self._frame

    @property
    def play_index(self) -> int:
        return self._play_index
