"""Interview loudness matcher.

Import short interview clips, measure the speech that actually matters,
derive a single gain per clip from a shared reference, detect clips where a
peak ceiling prevents reaching the target, export matched audio plus a
measurement report, and re-measure the rendered result.
"""

__version__ = "1.0.0"
