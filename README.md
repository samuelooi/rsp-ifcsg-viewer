# RSP IFC-SG Viewer & Checker

A browser-based IFC viewer that queries and checks models against the **CORENET X
IFC-SG mapping** — the same workbook the agencies use to interrogate submissions.

Everything runs locally in the browser. No model is uploaded anywhere.

## Running it

The app uses ES modules and fetches its ruleset, so it must be served over HTTP —
opening `index.html` from disk will not work.

```powershell
powershell -File tools/serve.ps1          # http://localhost:8080
powershell -File tools/serve.ps1 -Port 9000
```

Then open the URL and drop one or more `.ifc` files on the window.

## Working with models

**Several files can be open at once** and are treated as one federated model —
queries, colouring and the compliance check all span them. Drop or choose
multiple files, or add them one at a time. Each loaded file appears at the top of
the left panel with its mapped-element count, an eye toggle to show/hide it, and
a `×` to close it.

Because `expressID` is only unique *within* one IFC file (they genuinely collide
between files), every element is identified as `modelID:expressID` throughout.

**Models align on their authored coordinates.** IFC files in a set are modelled
against a common survey origin, usually far from (0,0,0). web-ifc's
`COORDINATE_TO_ORIGIN` shifts a model to the origin using a transform derived
from *that file alone* — correct for one model, but it gives every file a
different shift and destroys their relative placement. So the first file loaded
establishes the datum: it is re-centred normally, the transform web-ifc used is
captured, and every later file is loaded with that same transform and no
re-centring of its own. Closing all models clears the datum, so an unrelated
project loaded afterwards establishes its own.

The transform is applied inside web-ifc rather than by moving the mesh, so
vertices are generated already near the origin — which matters because web-ifc
returns them as float32, and real survey coordinates are large enough to cost
millimetres of precision.

**Visibility** is controlled three ways:

- **Right-click any element** for a menu: hide it, hide everything of that entity
  type, isolate it, show its properties, or **Show all**. Right-clicking empty
  space gives you Show all and Fit view.
- **The space toggle** in the tool rail shows or hides `IfcSpace` volumes. Spaces
  start hidden, because they are solid volumes that bury the rest of the model.
  Running a query or check result that targets spaces turns them back on
  automatically — the toggle lights up so it is visible that it happened.
- **Show all** in the tool rail (also in the right-click menu) clears every hide,
  restores closed-off models, and shows spaces again. It lights up whenever
  something is hidden, so the view is never mysteriously incomplete.

Hiding is implemented by rewriting the base mesh's index buffer so hidden
elements collapse to zero-area triangles. That costs only the hidden elements'
indices rather than rebuilding the model, so it stays instant on large files, and
it leaves the colour overlays untouched (they read from a separate pristine
index cache).

## Project dashboard

The **Dashboard** button totals the headline quantities across the whole
federated model, with breakdowns **by level**, **by file**, or totals only.

| Metric | Definition |
| --- | --- |
| Gross Floor Area | `IfcSpace` · ObjectType `AREA_GFA` · where `SGPset_SpaceArea_Verification.AVF_IncludeAsGFA` is True · sums `SGPset_SpaceDimension.Area` |
| Planting Areas | `IfcGeographicElement` · `*PLANTINGAREAS` · sums `SGPset_GeographicElementDimension.Area`, with encroachment and compensated sub-totals |
| Parking Lots | `IfcBuildingElementProxy` · `*CARLOT`, `*MOTORCYCLELOT`, `*LORRYLOT`, `*COACHLOT`, `*ARTICULATEDVEHICLELOT`, `*BICYCLELOT` · counted per type |
| Refuse & Recycling Bins | `IfcTank` · `*RECYCLINGBIN`, `*REFUSEBIN` · sums `SGPset_Tank.Litre` |
| Refuse Handling Equipment | `IfcTank` · `*REFUSECONTAINER`, `*REFUSECOMPACTOR`, `*RECYCLABLECONTAINER`, `*RECYCLABLECOMPACTOR`, `*REFUSEHANDLINGEQUIPMENT` · sums `Pset_TankTypeCommon.NominalCapacity` |
| Site Coverage | `IfcBuildingElementProxy` · `*SITECOVERAGE` · area |
| Site Area | `IfcGeographicElement` · `*SITEBOUNDARY` · sums `SGPset_GeographicElementDimension.Area` |

Every card quotes the mapping row it comes from and the property the value was
actually read from, so a figure can be traced back. **Show in model** colours
those elements in the 3D view.

Three things worth knowing about how it reports:

- **Encroachment and Compensated are Booleans** in the mapping, not quantities.
  The sub-totals are therefore the *area of planting areas flagged* with each,
  not separate measurements.
- **Site Coverage has no area property in the mapping** (the row declares
  `N.A`), so the value is taken from whichever candidate property set the model
  carries, and the card names the one used.
- **A metric with no elements is flagged**, and where similarly named elements
  exist the card says so. A model that types its GFA spaces with the IFC4 `GFA`
  PredefinedType instead of the mapping's `AREA_GFA` reads as *"elements are
  present but would not be found by the authority's query"* rather than as an
  empty card — which is the finding that actually matters.

Refuse capacity lives on `IfcTank`, which is MEP and so absent from the
architectural ruleset. The dashboard declares its own entities
(`DASHBOARD_ENTITIES` in `js/dashboard.js`) and those are indexed regardless of
the discipline scope.

## The two features

### Preset queries (Queries tab)

The left panel lists every building component the mapping identifies, grouped by
agency. Each row shows the IFC entity and accepted subtypes, plus how many
matching elements are in the loaded model.

- **Click a component** — colours those elements and ghosts the rest.
- **Expand it and click a property** — colours the elements *by that property's
  value*, with a legend of every distinct value and its count. Elements that do
  not carry the property fall into a red `(not set)` bucket.
- **Click a legend row** — solos that value. Click it again to bring the rest back.

Filters narrow the list by agency, by discipline, or by free text, and
"Only components present in model" hides everything the model does not contain.

The tool rail toggles how the un-selected remainder is drawn — ghosted, hidden,
or normal.

### Compliance check (Compliance tab)

Runs every mapped requirement against every matching element and reports:

| Status | Meaning |
| --- | --- |
| Compliant | Present and valid |
| Property set missing | e.g. no `SGPset_Wall` on the element |
| Property missing | Set present, property absent |
| Value empty | Present but blank |
| Value not in accepted list | Outside the workbook's enumeration or Space Values list |
| Wrong data type | Non-numeric where a Length/Area/Volume is required |

The agency and discipline filters also scope the check. **Colour** paints the
whole model by each element's worst status, and clicking a component in the
results colours its compliant and non-compliant elements against each other.

Clicking any element opens an inspector showing its identity, every applicable
IFC-SG requirement with live pass/fail, and every property set actually present —
so a flagged value can be checked against what the model really contains.

## Regenerating the ruleset

`data/ifcsg-rules.json` is **generated** — do not hand-edit it. When BCA publishes
an updated mapping workbook:

```powershell
powershell -File tools/build-ifcsg-rules.ps1 -Xlsx "<path to the new mapping.xlsx>"
```

### Discipline scope

The build is currently limited to the **architectural** scope — `-Disciplines`
defaults to `ARC` and `External Works`, and the STR and MEP rows (426 of them)
are excluded. To bring the engineering disciplines back:

```powershell
# everything
powershell -File tools/build-ifcsg-rules.ps1 -Disciplines @()

# architecture plus structures
powershell -File tools/build-ifcsg-rules.ps1 -Disciplines ARC,'External Works',STR
```

The script prints what it kept and excluded, and the scope is recorded in the
JSON's `meta.disciplines`.

The script reads the *CX Pilot Mapping* and *Space Values* sheets directly from
the `.xlsx` (it copies the file first, so it works even while the workbook is open
in Excel) and rewrites the JSON. The current build carries **407 rules / 329
property requirements / 159 components** over 29 IFC entities, across BCA, LTA,
NEA, NPARKS, PUB, SCDF, URA and cross-agency rows. (The full workbook holds 833
rules; the rest are STR and MEP — see below.)

## How the mapping is interpreted

These are the decisions the generator and matcher make about the workbook. They
matter if you are comparing results against the agencies' own checker.

- **`*` prefix on a subtype** means the IFC `PredefinedType` is `USERDEFINED` and
  the real name is carried on `ObjectType`. Exporters are inconsistent here, so a
  starred subtype matches against *either* field.
- **"Standard case" entities are folded onto their base.** Revit exports most
  walls as `IfcWallStandardCase`; the mapping only names `IfcWall`. The same
  applies to slabs, beams, columns, doors, windows, members and plates.
- **`N.A` means not applicable** and becomes `null`, not the literal string.
- **Rows reading "Please refer to property sets below"** only declare that an
  entity/subtype belongs to a component; they carry no property requirement.
- **Accepted Values** is classified rather than guessed — an enumeration, a
  `TRUE/FALSE` boolean, "Any positive number", or a cross-reference to the Space
  Values sheet (1,405 values across 10 properties, with `AGF_Name` scoped by
  development use).
- **Property set, property name and value comparisons are case-insensitive**, so
  exporter casing differences are not reported as failures.
- **Booleans display as `True` / `False`.** IFC stores them as STEP enumerations
  (`.T.` / `.F.`), which web-ifc hands back as the bare strings `"T"` / `"F"`.
  Those are normalised to real booleans when the model is indexed, so the
  inspector, the legend and the check report all read the same way. `IfcLogical`'s
  third state is kept distinct as `Unknown`, and a `False` value is treated as a
  real answer — never as a missing one.

### One thing to be aware of

Some mapping rows specify an entity with **no subtype** — `Household Shelter`, for
example, is `IfcWall` with subtype `N.A`. Matching is faithful to the workbook, so
that component selects *every* wall in the model, and its requirements are checked
against all of them. That is what the authority's own query does; it is not a bug
here. Use the agency filter and the per-component breakdown to read those results
in context.

## Layout

```
index.html                  shell, styles, panel markup
js/viewer.js                three.js scene, multi-model loading, visibility, overlays
js/ifc-index.js             walks each IFC once into a queryable element index
js/ifcsg.js                 ruleset indexing, element matching, compliance rules
js/dashboard.js             project quantity metrics, totalled by file and level
js/app.js                   UI wiring: models, presets, legend, check, dashboard
data/ifcsg-rules.json       generated ruleset (do not edit)
tools/build-ifcsg-rules.ps1 workbook -> ruleset
tools/serve.ps1             local static server
```

`ifc-index.js` walks the relationship tables once at load rather than querying
web-ifc per element, which is what keeps this fast: a 55 MB architectural model
indexes 2,268 mapped elements in under a second, and the full check over 24,000
property assertions is effectively instant.

## Memory

Geometry dominates — on a 71 MB IFC the vertex buffers come to roughly a
gigabyte, against 142 MB for the parsed IFC and under 8 MB for the whole property
index. Two things are done about it:

- **The parsed IFC is released once indexed.** Everything after indexing —
  colour subsets, picking, hiding — runs off the three.js geometry and the index
  map, so `viewer.releaseModelData()` closes the wasm model. This does not lower
  the peak for a single file (the heap has to grow to parse it either way); what
  it changes is that loading several files reuses one model's worth of heap
  instead of accumulating. Measured over three files: peak 74.8 MB → 36.5 MB, and
  flat rather than climbing as files are added.
- **Normals are stored as signed bytes** rather than float32 (`COMPRESS_NORMALS`
  in `viewer.js`). Measured worst angular error 0.002°, saving 268 MB on that
  71 MB file — buffers 980 MB → 712 MB.

Things that were measured and do **not** help, so they are not worth trying:
disabling `IfcSpace` geometry (0.1% of the total), and the `CIRCLE_SEGMENTS`
tessellation settings (no effect — Revit exports faceted BREP, not curves).

The remaining levers are upstream: 31 million vertices for one building is a
heavy export, and no viewer-side change beats reducing that. Note also that
closing a model frees heap for reuse but never returns it to the OS, so only a
page reload truly resets a session.
