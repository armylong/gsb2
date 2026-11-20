"""Boundary checker for binary masks.

Pipeline: binary mask -> pixel-exact boundaries (outer / hole, per component)
-> optional simplification -> closure validation -> JSON export + raster
reconstruction.  The GUI and the CLI share every step in this package.
"""

__all__ = [
    "maskio",
    "geometry",
    "extract",
    "simplify",
    "validate",
    "render",
    "export",
    "samples",
    "report",
]

__version__ = "1.0.0"
