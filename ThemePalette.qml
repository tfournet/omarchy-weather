import QtQuick
import Quickshell.Io
import qs.Commons
import "Palette.js" as Palette

// The theme's named colours (red, yellow, orange, green, blue, magenta, cyan),
// which the shell's Color singleton does not expose, turned into weather roles.
// The basics (foreground, background, accent, muted) come from Color itself so
// they are always the live theme; only the named colours are read from the
// theme's colors.toml. The choices live in Palette.js.
Item {
  id: root

  // Tinted accents to use for a weather colour the theme does not name:
  // sun, rain, snow, storm, fog as "#rrggbb".
  property var fallbacks: ({})

  // Parsed colors.toml: mode and the named colours, empty until it loads.
  property var theme: ({ mode: "" })

  readonly property var inputs: {
    var p = {}
    for (var key in theme) p[key] = theme[key]
    p.foreground = String(Color.foreground)
    p.background = String(Color.background)
    p.accent = String(Color.accent)
    p.muted = String(Color.muted)
    return p
  }

  // { sun, rain, snow, storm, fog, rainBar, rainAmount, tempHigh, tempLow,
  //   tideHigh, tideLow, uv: [five bands] }
  readonly property var roles: Palette.roles(inputs, fallbacks)

  visible: false
  width: 0
  height: 0

  FileView {
    id: colorsFile
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.theme = Palette.parseColors(text())
    onLoadFailed: root.theme = Palette.parseColors("")
  }

  // A theme switch swaps the directory behind currentThemePath, which a file
  // watch can miss. The shell updates these when it applies a new theme, so
  // read the file again then.
  Connections {
    target: Color
    function onAccentChanged() { colorsFile.reload() }
    function onBackgroundChanged() { colorsFile.reload() }
    function onForegroundChanged() { colorsFile.reload() }
  }
}
