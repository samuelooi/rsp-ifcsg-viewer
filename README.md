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

The server also handles `GET` and `PUT` requests to `/api/presets`, which read
and save `data/value-presets.json` (see [Value presets](#value-presets)). It
only listens on `localhost`, and it refuses writes that come from another
origin.

## Working with models

**Several files can be open at once** and are treated as one federated model —
queries, colouring and the compliance check all span them. Drop or choose
multiple files, or add them one at a time. The model name at the top left is a
drop-down listing every loaded file with its mapped-element count, an eye toggle
to show/hide it, and a `×` to close it. With nothing loaded, clicking it opens
the file picker.

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
  space gives you Show all and Fit view. While a query is showing, **Isolate
  selected components** hides everything the query does not colour — with a
  legend row soloed, only that row's elements stay.
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

The left panel shows every building component the mapping identifies as a
bubble, grouped by agency, with how many matching elements the loaded model
holds. Hover a bubble to see the IFC entities and subtypes it covers.

- **Click a component** — colours its elements *by what each one is* (entity
  plus subtype), with a legend of every kind and its count. *Family-Friendly
  Furniture* therefore splits into CHANGINGBED, CHILDPROTECTIONSEAT and
  DIAPERCHANGINGTABLE. The workbook lists a component once per selector row and
  those rows overlap (Railing: any subtype *and* GUARDRAIL); the rows are folded
  together and each element counted once, so the numbers add up.
- **A Properties section then appears** with one bubble per property the
  mapping requires. A component spanning several entities (Household Shelter:
  walls, spaces, outlets…) lists them under entity labels, since a property
  belongs to one entity. **Click a property** — colours the elements of that
  entity *by the property's value*, with a legend of every distinct value and
  its count; elements that do not carry the property fall into a red `(not set)`
  bucket, and the rest of the component is ghosted.
- **Click a legend row** — solos that value. Click it again to bring the rest back.

Two rows of bubbles above the list set the scope, macro to micro. **Gateway**
first: *Construction Gateway* is the whole mapping, *Design Gateway* the subset
the workbook marks `DG`. Then **authority**: picking one shows its own
components and, under an *All authorities* heading, the ones the workbook
assigns to `All` — those are queried by every agency, so they belong under each.
Above the bubbles, "Only components present in model" hides everything the
loaded model does not contain; below them, a search box filters by component or
property name.

The tool rail toggles how the un-selected remainder is drawn — ghosted, hidden,
or normal.

### Compliance checks (Compliance tab)

The tab opens on a **menu of available checks, grouped by authority**. Tick the
ones to run and press the run button; the selection is remembered between
sessions. Each check reports into its own section, and the summary at the top
totals them together.

| Check | What it asks |
| --- | --- |
| IFC values | Does the model carry the data the CORENET X mapping requires? |
| Geo-referencing | Is the model in the right place on the ground? |
| URA requirements | GFA parameters, sanity rules, required elements, submission limits |
| BCA requirements | Do the BCA building rules hold? *(no rules defined yet)* |

The distinction between the first and the others is the important one. **IFC
values is a data check** — it validates that properties are present, populated
and within their accepted values. **The authority checks are building checks** —
they read those values and test them against what the agency publishes. A model
can pass the first and fail the second.

BCA is wired up and runs, but carries no rules yet, so it reports nothing. Its
rules are deliberately absent rather than guessed: a plausible-looking rule that
is wrong reads as an authoritative result.

#### The IFC values check

Runs every mapped requirement against every matching element and reports:

| Status | Meaning |
| --- | --- |
| Compliant | Present and valid |
| Property set missing | e.g. no `SGPset_Wall` on the element |
| Property missing | Set present, property absent |
| Value empty | Present but blank |
| Value not in accepted list | Outside the workbook's enumeration or Space Values list |
| Wrong data type | Non-numeric where a Length/Area/Volume is required |

The gateway and authority bubbles also scope the check. **Colour** paints the
whole model by each element's worst status, and clicking a component in the
results colours its compliant and non-compliant elements against each other.

Clicking any element opens an inspector showing its identity, every applicable
IFC-SG requirement with live pass/fail, and every property set actually present —
so a flagged value can be checked against what the model really contains.

#### Value presets

Your own property queries, run with the IFC values check. The CORENET X
mapping only covers what the agencies ask for; a preset covers something
it doesn't, like "every door on this job has `Pset_DoorCommon.FireRating` 60".

A preset has two parts:

- **Selector**: an IFC entity plus, optionally, one or more subtypes. A
  subtype matches either `PredefinedType` or `ObjectType`.
- **Condition**: a `Pset.Property` must exist, have a value, equal, not
  equal, be one of, contain, match a pattern, or be `>` / `≥` / `<` / `≤`
  a number.

Tick **IFC values** in the Compliance tab, then **+ New preset**. With a
model loaded, the editor fills in its suggestions from that model: the
entities and subtypes it contains, the property sets on the selected
elements, and the values those properties actually hold. Click a value chip
to use it.

- **Show in 3D** colours the elements that meet and don't meet the condition,
  so you can check the preset selects the right things before you save it.
- **By value** colours the selected elements by the property's value.

In the list of saved presets, **3D** shows what a preset selects, and its
checkbox sets whether the check runs it. After a run, each preset gets its own
result block. Click a block to colour its passing and failing elements.

Presets are saved to `data/value-presets.json` via `tools/serve.ps1`.
Commit that file to share them with the team. On a static host, without that
server, presets still load and run, but can't be edited.

Numbers are compared in the units the model was authored in. An entity the
ruleset doesn't cover (such as `IfcTank`) is only read from models loaded
*after* the preset that needs it was saved, so reload any model that's already
open.

### URA requirements

Reverse-engineered from the URA Revit Model Quality Checker Plugin user guide,
section 7. **Twenty rules**, each citing the guide section it came from.

Select the **submission gateway** first. URA runs two, and they differ
substantially: the Design Gateway asks for far less than the Construction
Gateway. Rules belonging to the other gateway are not run and not reported —
an unasked rule is not the same as an unanswered one. The selector defaults to
Construction, because a forgotten selection should over-report rather than
quietly skip requirements.

| Guide | Rules | What they check |
| --- | --- | --- |
| 7.3 | 6 | Core parameters populated. Thresholds are the main gateway difference: the Design Gateway wants at least one `AGF_Name` and one `ALS_LandscapeType`; the Construction Gateway wants 50% `AGF_Name`, 50% `AGF_DevelopmentUse`, 20% `AVF_IncludeAsGFA`. |
| 7.5 | 6 | The sanity rules. Private strata counts as GFA, bonus GFA counts as GFA, GFA areas declare a use, dwelling units exist and carry unit numbers. |
| 7.7 | 3 | Area_GFA objects, a site boundary and Existing terrain are present. |
| 7.8 | 2 | Every file within 800 MB, and level names consistent with the lowest level under 100 m (100000 mm). |
| 7.9 | 3 | Export settings, read back from the file. |

Three things about how this differs from the Revit original.

**Some checks could not come across, and were dropped rather than faked.** The
active view being a 3D view, the mapping file's format, elements hidden in a
view, and every "wrong Revit family category" clause are all properties of a
Revit session that an exported IFC does not record. Guide section 7.2 was
dropped for a subtler reason: its point is that the Revit template *declares*
every parameter even when unused, but Revit omits empty parameters on export, so
"declared but blank" and "never declared" are indistinguishable downstream.

**Section 7.9 was reinterpreted rather than transcribed.** The guide checks
Revit's export dialogue, which is gone by the time an IFC exists. Instead these
read the fingerprints those settings leave behind: whether common property sets
are present, whether base quantities are present, and whether the model exports
to a single `IfcSite`. That last one is worth having — a test file here carries
three, one of them a scupper drain mapped to `IfcSite` by mistake.

**Lengths are reported in millimetres**, normalised from whatever unit each file
was authored in, and rounded to three decimals. Both halves matter. Normalising
means a federated set that mixes units is judged on height rather than on raw
numbers, and it is why the 100 m ceiling is applied as 100000 mm — comparing a
millimetre model against 100 would fail it at ground level. Rounding removes
exporter noise: a level drawn at −500 is written as −499.9999999999913, and two
levels differing only in that tail would otherwise read as inconsistent.

Level elevations are also resolved through the placement chain to one datum
rather than read from the `Elevation` attribute, which is relative to whatever
contains the storey. On the test file that is the difference between a declared
−500 and an absolute 13500, and it is what exposes two storeys sharing a name
200 mm apart.

**Vocabulary (7.4) is not checked here.** Those four parameters are already
validated by the IFC values check against the mapping workbook. Checking them
twice would give one element two verdicts from one run. Instead URA's list is
merged into the workbook's, which matters because **the two published sources
disagree**:

| Parameter | Difference |
| --- | --- |
| `AGF_DevelopmentUse` | None; 25 values identical |
| `AGF_BuildingTypology` | The workbook carries 16 values the guide omits, including Data Centre and Polyclinic |
| `AGF_BonusGFAType` | The guide has `Utility GFA for DCS/CCS networks`; the workbook does not |
| `AST_AreaType` | The guide says `Communal Area`, the workbook says `Common Area` |

`data/ifcsg-rules.json` is generated and must not be hand-edited, so the values
URA accepts and the workbook lacks live in `data/ura-vocabulary.json` and are
merged at load. Both `AST_AreaType` spellings are accepted rather than guessing
which one a reviewer applies.

### Geo-referencing (URA)

Modelled on the URA Revit Model Quality Checker's geo-referencing check. It
answers one narrow question: **is this model in the right place on the ground?**
Not whether the building complies with anything — whether the coordinates it was
authored against put it inside the land it is supposed to occupy.

Select the check and a file picker appears for the **cadastral lot GeoJSON**.
Get it from URA's site-information service: search the MK lot number, then
*Download Cadastral Lot(s)* and *Download in GeoJSON format*. One file per run,
so a development spanning several lots needs them all in the one file. There is
also a fallback for a lot that is not in the cadastral database: three surveyed
vertices in SVY21, checked against the site boundary to ±20 mm.

It reports:

| Assertion | Meaning |
| --- | --- |
| Model is georeferenced | An `IfcMapConversion` exists. Without it nothing else can be checked. |
| Coordinate system is SVY21 | The CRS is EPSG:3414. Anything else will not line up. |
| Site boundary is modelled | An `IfcGeographicElement` with ObjectType `SITEBOUNDARY`, as the URA plugin looks for. |
| Model sits within the SVY21 extent | Catches a model left at the origin or georeferenced into the sea. |
| All files share the same coordinate reference | URA's shared-coordinates requirement, as it applies to a federated set. |
| Model lies within the cadastral lot | Every footprint vertex falls inside the lot. |
| Site boundary follows the lot line | Where a boundary is modelled, how far it departs from the cadastral line. |
| IfcSite latitude and longitude agree | Cross-checks the site's declared position against the map conversion. |

**Show on model** draws the cadastral lot in green and the site boundary in
blue, on the ground plane, as the URA plugin does. The tool rail clears them.

Three things are worth knowing about how it works.

**The scale trap.** `IfcMapConversion.Scale` converts project units to map
units, so a Revit export in millimetres onto a metre-based CRS carries 0.001.
But web-ifc has already converted the geometry to metres, so applying that scale
again shrinks the model by a thousand and it lands silently in the wrong place.
The effective scale is `Scale / metresPerUnit`, which for that common case is
exactly 1. The axis swap is the other trap: web-ifc hands three.js a Y-up scene
where `scene = (x, z, -y)`, and losing the sign on that mirrors the model about
north.

**Containment is tested on the footprint hull, never the bounding box.** A
bounding-box corner is not a point of the model. On the test model two of four
box corners fall outside the lot while all ten real footprint vertices are
inside, clearing the boundary by 0.73 m. The hull is also computed *exactly*
rather than from sampled vertices: the hull of a sample is contained by the true
hull, so sampling can miss a corner poking over a boundary. Exactness is
affordable because eight extreme points form an octagon that is provably inside
the hull, and everything within it is discarded in one linear pass before
anything is sorted.

**Where no site boundary is modelled**, containment falls back to the extent of
the model geometry, and the report says so. A convex extent overstates a concave
footprint, which makes that fallback conservative rather than lenient.

The SVY21 projection is checked against published control values: the projection
origin reproduces the false easting and northing exactly, a forward-and-back
round trip over the whole island is accurate to 0.21 mm, and the projected area
of the test lot matches the area URA's own file declares to five decimal places.

## Adding a check

Checks are modules under `js/checks/`. The framework exists so that a new
authority is a new folder plus one line in the registry, and touches nothing
else.

### How it fits together

```
js/checks/registry.js     what checks exist; static metadata + dynamic import
js/checks/runner.js       runs a selection, one at a time, with progress
js/checks/severity.js     the one vocabulary every module shares
js/checks/types.js        the module contract, as documentation
js/checks/authority-kit.js   turns a list of rules into a working check
js/checks/<id>/index.js   a check module
js/checks/<id>/rules.js   its rules, where it is rule-driven
```

A check that needs something from the user — a cadastral lot file, a set of
surveyed coordinates — declares it as an `inputs` entry in the manifest. The
menu renders the control under that check when it is selected, reads a file to
text before the check ever sees it, and hands the values over as `ctx.inputs`.
A check that needs mesh vertices declares `needsGeometry` and receives
`ctx.geometry`; that is the one part of the context which is not plain data, and
therefore the one thing keeping such a check on the main thread.

**Metadata is static, implementation is lazy.** The registry manifest is always
in memory, so the menu renders and the model indexer knows which IFC entities to
collect without downloading a single check. The module itself is fetched the
first time its check actually runs — a session that never runs the URA check
never loads it. The IFC values module is the one exception: the element
inspector reads live pass/fail from it, so it is fetched at boot.

That split matters more than it looks. The model is walked **once** at load and
the parsed IFC is released immediately afterwards, so an entity a check needs
must be declared before indexing. Declaring it in the manifest rather than in
the module is what makes loading the module late safe.

### The contract

A module exports `run`, and optionally `render` and `explain`. The full shape is
documented in `js/checks/types.js`. Three rules keep it working:

- **`run` is pure** — index in, findings out, no DOM and no viewer. That is what
  lets a check be tested against a fixture index and, later, moved into a Worker.
- **The shell owns the 3D view.** A module never colours or hides anything; it
  asks through `actions.showInModel`, and one code path does the work.
- **Findings carry a shared `severity` and a module-specific `code`.** Severity
  answers "how bad" so the shell can count and colour findings from a module it
  knows nothing about; the code answers "what" for display.

### A rule-driven authority check

URA and BCA are built from `createAuthorityCheck`, which takes a list of rules
and supplies all the iteration, counting and rendering. Adding a rule is an edit
to an array — there is no control flow to get wrong:

```js
{
  id: 'ura-gfa-use-declared',
  title: 'Every GFA space declares its development use',
  reference: 'URA — development control, use classification',
  severity: SEVERITY.FAIL,
  applies: (ctx) => ...,              // optional: is the rule in scope at all?
  select: (ctx) => [...elements],     // what it applies to
  assert: (el, ctx) => true | 'why it failed',
}
```

A rule whose `applies` returns false is reported as **not evaluated**, which is
deliberately not the same as passed. For rules about totals rather than
elements, a rule may supply `evaluate(ctx)` and return findings directly.

## Regenerating the ruleset

`data/ifcsg-rules.json` is **generated** — do not hand-edit it. When BCA publishes
an updated mapping workbook:

```powershell
powershell -File tools/build-ifcsg-rules.ps1 -Xlsx "<path to the new mapping.xlsx>"
```

Columns are found by their header text, not their position, so adding a column
to the workbook does not break the build. If a header is renamed the script
stops and names the column it could not find.

### The Gateway column

The authority workbook says nothing about which CORENET X submission gateway a
requirement belongs to. RSP's copy adds a **Gateway** column (`DG` = Design
Gateway, `CG` = Construction Gateway) next to *Agency*, and the build carries it
through as `gateway` on every rule. The Queries tab groups components by it.

The Construction Gateway is checked for **everything**, so a `DG` row belongs to
both gateways and a `CG` row only to Construction. The Design Gateway is the
subset. A row with the column blank is treated as `CG`.

It is read **per row**, because the two gateways can want different things
from the same component: for `Space (Usage)` the Design Gateway asks only for
`SpaceName`, while the Construction Gateway asks for all 31 properties. Such a
component appears under each gateway with that gateway's own list.

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
property requirements / 159 components** (75 of them also at the Design
Gateway) over 29 IFC entities, across BCA, LTA,
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
js/ifcsg.js                 ruleset indexing, element matching, value evaluation
js/dashboard.js             project quantity metrics, totalled by file and level
js/memory.js                tab memory estimate, budget and pre-load forecast
js/util/dom.js              escaping and colour helpers shared with check modules
js/geo/svy21.js             WGS84 <-> SVY21 (EPSG:3414) projection
js/geo/polygon.js           rings: area, containment, distance, convex hull
js/geo/geojson.js           reads URA cadastral lot exports
js/geo/georef.js            scene <-> survey coordinates, via the map conversion
js/checks/                  the check framework and the checks themselves
js/app.js                   UI wiring: models, presets, legend, checks, dashboard
data/ifcsg-rules.json       generated ruleset (do not edit)
data/ura-vocabulary.json    values URA accepts that the workbook lacks (hand-maintained)
data/value-presets.json     the team's value presets (written by the app)
tools/build-ifcsg-rules.ps1 workbook -> ruleset
tools/serve.ps1             local server: static files plus /api/presets
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

### Memory meter

The top bar shows an estimate of the tab's memory against a budget, so an
oversized model is visible before the tab crashes rather than after. Browsers
report almost nothing useful here: `performance.memory` covers only the
JavaScript heap, and a model's memory lives outside it in typed arrays and the
wasm heap. So the meter adds up what the app allocates itself:

| Part | How it is measured |
| --- | --- |
| Geometry buffers | every vertex and index buffer held by three.js, counting attributes shared between a model and its overlays once, plus the per-model index cache |
| wasm heap | the web-ifc heap, which grows to fit the largest file parsed and never shrinks |
| JavaScript heap | `performance.memory.usedJSHeapSize` where the browser provides it (Chromium) |

GPU driver copies are not included; they live in another process, and it is the
renderer process that runs out.

The ceiling is a **budget, not a measured limit** — there is no API for the
real one. It defaults to 4 GiB, which is where a 64-bit Chromium tab holding
large typed arrays becomes unstable in practice, and is halved on machines that
report less than 8 GB of RAM. Override it per session with `?membudget=6` (GiB)
in the URL. The meter turns amber at 60% and red at 85%, with a one-off toast on
entering the red band.

Before a file is parsed, the expected footprint is projected from its size
using the ratios measured above (about 10x the IFC size resident, 12x at peak).
A projection past the budget produces a warning toast but does not block the
load — the parse cannot be interrupted once started, so the point is to give the
user the chance to close something first.
