Generated sample PNGs used by the tool, tests and docs.
Regenerate with: npm run samples:write
The generator is deterministic (no randomness), so repeated runs
produce byte-identical files.

characters/hero_idle.png      irregular character, 64x96 canvas
characters/hero_run_1..3.png  same canvas, different silhouette
alternate/hero_idle.png       same basename, different directory and pixels
ui/empty_placeholder.png      fully transparent frame (kept, not dropped)
effects/slash.png             irregular effect with semi-transparent edges
ui/hollow_frame.png           hollow frame, trim keeps the full canvas
strips/tall_banner.png        16x300 strip, packs rotated
strips/wide_banner.png        260x14 strip, packs rotated
characters/tiny_dot.png       off-center 2x1 content inside an 8x8 canvas
backgrounds/big_ring.png      220x220 frame, unplaced on small pages
