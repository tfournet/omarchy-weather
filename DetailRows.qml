import QtQuick
import qs.Commons
import "Palette.js" as Palette

// Label / value pairs for a detail card, in two columns. The entries come
// pre-formatted from Detail.js; this only draws them. An entry with `segments`
// draws each piece in the colour of its tone, taken from `roles`; the rest of
// the text stays the foreground.
Grid {
  id: grid

  property var entries: []
  property var roles: ({})
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family
  readonly property color dim: Util.alpha(foreground, 0.8)

  columns: 2
  columnSpacing: Style.space(16)
  rowSpacing: Style.space(6)

  function segmentColor(tone) {
    var hex = Palette.toneColor(roles, tone)
    return hex !== "" ? hex : foreground
  }

  Repeater {
    model: grid.entries

    Row {
      id: entryRow
      required property var modelData
      width: (grid.width - grid.columnSpacing) / 2
      spacing: Style.space(6)

      Text {
        textFormat: Text.PlainText
        width: parent.width * 0.48
        elide: Text.ElideRight
        text: entryRow.modelData.label
        color: grid.dim
        font.family: grid.fontFamily
        font.pixelSize: Style.font.caption
      }

      Item {
        width: parent.width * 0.52 - parent.spacing
        height: valueRow.implicitHeight

        Row {
          id: valueRow
          anchors.right: parent.right

          Repeater {
            model: entryRow.modelData.segments && entryRow.modelData.segments.length > 0
              ? entryRow.modelData.segments
              : [{ text: entryRow.modelData.value, tone: "" }]

            Text {
              required property var modelData
              textFormat: Text.PlainText
              text: modelData.text
              color: grid.segmentColor(modelData.tone)
              font.family: grid.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }
      }
    }
  }
}
