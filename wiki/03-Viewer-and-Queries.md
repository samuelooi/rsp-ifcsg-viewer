# Viewer and queries

## Controls (Forma style)

| Action | Mouse |
| --- | --- |
| Orbit | Left drag |
| Pan | Right drag or middle drag |
| Zoom | Wheel |
| Pick element | Left click |
| Context menu | Right click (no drag) |

Plan view (the levels tool) is a straight-down orthographic camera; left drag
pans there since there is nothing to orbit.

## Section cuts

Arm the section tool in the rail, then click a face of the model. The cut goes
through the clicked point with its normal snapped to the nearest world axis, so
every cut is a clean X, Y or Z plane. The side the camera is on is discarded,
so clicking a wall's outside leaves the cut on that wall, ready to slide inward.

The cut is drawn as a translucent yellow rectangle across the model's bounding
box with an arrow into the kept half. Drag the rectangle to slide the cut along
its axis. Dragging anywhere else still orbits, so the camera can be moved
between cuts without leaving the tool. The sections bar lists each cut with its
axis; flip and remove are there. Escape or clicking the tool disarms it.

## Queries

The QUERIES tab is driven by the CORENET X industry mapping workbook
(`data/ifcsg-rules.json`). Gateway first (Design or Construction), then
authority, then one flat row of component bubbles and, once a component is
chosen, one flat row of its properties.

- Clicking a **component** colours its elements by kind (entity plus subtype).
- Clicking a **property** colours them by that property's value; "(not set)"
  is a dedicated colour so a gap is visible. Clicking a legend row solos it.
- **Only components present in model** hides bubbles nothing matches.
- The search box filters components and properties by name.
- **Set value…** in the legend writes one value onto every element shown (see
  Editing).

Components are one bubble per name regardless of which authorities ask for it;
the tooltip's first line says which. Properties are deduplicated across the
entities a component spans; the tooltip names the entities.

## Aggregates: stairs, roofs, curtain walls

Revit exports these as containers with no geometry of their own. The index
records their parts and the viewer colours, hides and measures through them.
Clicking a stringer or railing resolves to its stair; clicking a flight opens
the flight with a "Part of" link to its stair, since the FireExit the authority
asks about sits on the stair.

## Hiding, ghosting, spaces

Right-click gives hide element, hide all of this entity, isolate, and isolate
the queried components. The context button in the rail cycles ghost, hidden
and normal for unqueried geometry. IfcSpace volumes start hidden and switch on
automatically when a query or check result needs them.
