# Renders the README terminal screenshot of `onyx listen`.
#
# Render with charmbracelet/vhs (https://github.com/charmbracelet/vhs) from
# the repository root:
#
#   vhs assets/onyx-listen.tape
#
# The frame is seeded: scripts/demo-listen-frame.ts drives the real listen
# renderer (src/lib/tui.ts renderFrame) with hand-authored campaign data, so
# the image is pixel-faithful to the product without launching a research
# session. Edit that script to change workers, experiments, or metrics.
#
# JetBrains Mono must be installed (or reachable via XDG_DATA_HOME fonts) or
# the render falls back with broken letter-spacing.
#
# After rendering, style the screenshot (rounded corners, border, drop
# shadow on transparent padding — vhs cannot emit these itself):
#
#   python3 scripts/style-screenshot.py

Output assets/onyx-listen.gif

Set Shell "bash"
Set FontSize 28
Set FontFamily "JetBrains Mono"
Set Width 2400
Set Height 1560
Set Padding 48
Set Theme "Catppuccin Mocha"

Hide
Type "bun scripts/demo-listen-frame.ts"
Enter
Sleep 3s
Show

Sleep 2s
Screenshot assets/onyx-listen.png

Sleep 1s
