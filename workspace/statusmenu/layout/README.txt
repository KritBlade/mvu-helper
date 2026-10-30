WARNING - layout.json here is only a minimal EXAMPLE, shipped so the folder assembles.
ALWAYS create the real layout with MVU Status Menu Builder: design the menu graphically,
export its "Refresh layout .zip" and extract it into this statusmenu/ folder. It replaces
layout/layout.json AND engine/layoutFormatters.cjs - the formatters the layout's cell
formulas compute - and never touches engine/statusMenuLogic.cjs or pack.json. The two
always travel together: a layout.json dropped in alone names formatters nothing exports.
The builder owns the layout vocabulary - hand-editing this file means maintaining that
vocabulary by hand, and it WILL drift.
