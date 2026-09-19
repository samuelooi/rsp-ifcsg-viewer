# Process log — the September 2026 build, start to finish

This is the narrative of one working session (18 September 2026) in which the
tool went from a query viewer with a check framework to the submission
workbench described in the other pages. Each step records the question asked,
what was found, what was built, and how it was verified. Times are local.

## 1. Why FireExit on staircases did not highlight

**Question.** Selecting Staircase → FireExit coloured nothing in the model.

**Finding.** The rule exists (SCDF, construction gateway, `Pset_StairCommon.FireExit`)
and the property is present on the stairs. But every IfcStair in the CUP1 model
has an empty Representation: Revit exports a stair as a container whose
flights, landings, stringers and railings carry the triangles, linked by
IfcRelAggregates. The viewer built its colour overlay from the stair's own
express ID, so the subset had no triangles. Roofs and curtain walls in the RSP
main model are exported the same way. Separately, 24 of CUP1's 49 stairs have
a PredefinedType (NOTDEFINED, TWO_STRAIGHT_RUN_STAIR) the workbook does not
list, so the rule never selects them: a modelling issue, not a viewer one.

**Built.** The index records `hasGeometry` and, for geometry-less non-spatial
aggregates, the transitive list of parts (stopping at spatial elements so a
building never expands to its rooms). The viewer's colouring, hiding, hull and
floor sampling go through one `_geometryIds` helper. A pick on an unindexed
part resolves to its host; a flight shows a "Part of" link to its stair.

**Verified.** Headless on CUP1: 48 stairs, 0 with geometry, 1062 parts; the
FireExit query drew 35,668 triangles where before there were none; hiding a
stair hid its 7 parts.

## 2. Forma-style controls and section cuts

**Asked.** Left orbit, right and middle pan, wheel zoom; section cuts placed by
selecting a face, snapped to the XYZ axes.

**Built.** OrbitControls remapped (plan view keeps left as pan). The section
tool raycasts the clicked face, snaps its normal to the dominant world axis,
discards the camera side, and draws a translucent rectangle across the model's
bounding box with an arrow into the kept half. Dragging the rectangle slides the
cut along its axis; the grab is intercepted in the capture phase so the camera
never starts a gesture. Any other drag still orbits.

**Verified.** Headless on ADM1: a centre click placed a Y-axis cut at the roof,
a 60-px drag moved the anchor 1.548 m along Y only, an orbit-sized drag added
no cut, flip inverted the normal.

## 3. Flat query bubbles

**Asked.** No agency grouping; lump the component bubbles together, likewise
the properties.

**Built.** Component groups keyed by component name, agencies kept for the
tooltip and legend subtitle; property lists deduplicated by pset and property
across entities, with the entities in the tooltip. Selecting a property
colours every selector in the group that asks for it.

**Verified.** ADM1: 26 component bubbles with no duplicates; Staircase merges
BCA and SCDF into 8 properties; Door's 16 properties have no duplicates.

## 4. Project settings file

**Asked.** Save project information that determines the compliance checks,
reload it next time.

**Designed, then built on approval.** A JSON file with identity, submission
gateway and authorities, check selection, every check input (the cadastral lot
GeoJSON embedded as text, on the user's choice), preset ticks, expected model
files and the workbook stamp. One gateway drives both the query filter and the
URA check's selector. Authorities scope the query tab, the IFC values check and
the check menu. Saved through the File System Access API, opened by drop or
picker, remembered in a recent list, restored on the next visit.

**Verified.** ADM1: fill the panel, save, disturb the state, drop the file
back — gateway, authorities, checks and inputs restored; the earlier "not
restored" reading was a harness timing artefact under Chrome's virtual clock.

**Follow-up idea (designed, not built).** Per-model records in the same file so
federation checks can run one model at a time on small machines; see Roadmap.

## 5. The CORENET X Model Checker MVP guide

**Asked.** Study the guide's rules and suggest how to incorporate them.

**Delivered.** A mapping of the six schema checks and six quality checks onto
the existing checks, with effort and limits: schema version, project and site
structure, storey naming, cross-file coordinate alignment and level consistency
are cheap and index-only; QC03's structure checks belong inside the IFC values
check; clash detection and room coverage need geometry and can only be
approximated. The mapping is on the Roadmap page.

## 6. Feasibility of IFC and BCF editing, then the build

**Asked.** Check whether an IFC editing module and a BCF editing module can be
built; then build everything recommended.

**Found.** The bundled web-ifc can write but rewrites the whole file; the app
releases the parse after indexing; STEP files are one entity per line;
Chrome 153 has deflate streams for zip; Revit shares property lines across
sets (one FireExit line referenced by 38 sets in CUP1). Hence: patch-based
editing over the original bytes with clone-on-shared, and a native zip and
XML layer for BCF.

**Built.** `ifc-text.js` (one-pass scan of every entity's byte range, GUIDs,
schema, DATA end; STEP value parser and serialiser with string encoding),
`ifc-edit/editor.js` (element property sets, set / add / remove / move / rename
with clone-on-shared, byte-splice export, web-ifc validation of the changed
lines), `bcf/zip.js` and `bcf/bcf.js` (read and write, original XML preserved),
and the UI: Fix and Edit buttons in the inspector, Set value in the legend, an
edits bar with Export IFC, an Issues tab with import, topics, comments, status,
new topic with snapshot, findings-to-BCF, export.

**Verified.** ADM1 direct editor test: prepared 487,484 lines, appended four
new lines before ENDSEC, web-ifc re-parsed them with the right types and the
new relationship appeared in its type index (27,507 vs 27,506). Full app round
trip: exported file reloads with the cloned FireExit true, the in-place
NumberOfRiser 17, the added Remarks present, the other stair untouched, the
storey renamed. BCF: findings became 2000 topics in the Model Checker's
description format. The BCF export and re-import stalled twice under the
headless virtual clock on a blob-URL image preview (a testing artefact);
a rerun with a data-URL stub was in progress at handover.

## 7. Readiness report

**Asked.** After the checks, a PDF stating the project has been checked and is
ready for submission; prepare the format and build it in.

**Built.** A native PDF writer (Helvetica base fonts, WinAnsi text, rules,
boxes, JPEG images) and a flow layout (headings, key-values, tables that break
across pages with repeated headers, signature lines, footers with page x of y).
The content is derived from the outcomes only: strict verdict, project block,
snapshot, models, check summary including checks not run, per-rule tables for
rule-based checks, component breakdown for IFC values, outstanding failures
capped at 150 with a pointer to the BCF, warnings, hand edits, declaration
mirroring the Model Checker guide's wording, signature block.

**Verified.** ADM1 with a project file: a 10-page, 115 KB PDF with a valid
cross-reference table; visual review in progress at handover.

## 8. Space geometry check

**Asked.** Incorporate the community IFC Space Geometry Checker as a module.

**Found.** It tests one condition, `IfcSpace.Representation = $`, resolves the
level and the Revit lookup id from IfcSpaceType.Tag, and exports CSV. No fix.

**Built.** `checks/space-geometry/` as a filter over the index's `hasGeometry`
flag, with LongName and the type Tag added to the index, the same columns, CSV
download, findings for BCF and the report, and an inspector line. A synthetic
test file (ABCD BLK1 with one space's representation blanked) was made because
ADM1 has no such spaces; CUP1 has four.

## 9. Documentation

README sections for every feature, this wiki, and `HANDOVER.md`. Memory notes
for the next session record the test-model locations and the headless-testing
traps.

## What was not done

Nothing was committed. The per-model federation records, the Model Checker
quality checks and the check-only load path are designed only.
