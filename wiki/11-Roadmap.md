# Roadmap

Designed but not built, in the order they are worth doing.

## 1. Federation checks over saved records

The records themselves are built (see [Project file](02-Project-File.md)):
every run stores each model's identity, dashboard quantities, per-check results
and findings, and the panel reconciles them against what is loaded. What is
still to do is to let the **cross-file rules read them**.

Today URA 5.2 (level consistency) and the geo-referencing comparison see only
the merged index of what is open. They should instead see a federation view:
loaded models plus saved records, each under its file name. The records already
carry the storeys with elevations and the georeference, which is what those
rules need. Then a four-file submission checked one file at a time would report
the same level clashes as one checked with everything open.

Also worth adding: a files-by-checks grid on the Compliance tab, each cell from
a live run or a record with its date; and BCF export including findings from
records, so the issues file covers the whole submission.

Anything needing geometry from two files at once (clash detection, room
coverage against another discipline's slabs) cannot come from records.

A complementary option: a "check only" load that parses properties without
building geometry (about two times the file size in memory instead of ten),
losing the 3D view for those files.

## 2. CORENET X Model Checker MVP checks

From the Model Checker MVP Step-by-Step Industry Guide v1.0 (June 2026).

| MC check | Ours today | To do |
| --- | --- | --- |
| Schema 1 file readable | web-ifc fails at load | report it as a row |
| Schema 2 IFC4 to IFC4 ADD2 TC1 | not checked | read FILE_SCHEMA (the text scan already has it) |
| Schema 3 one IfcProject | not checked | count at index time |
| Schema 4 IfcSite under the project | URA 6.2 warns on several, not on none | use the aggregation map |
| Schema 5 entity recognised | web-ifc rejects unknown types | leave |
| Schema 6 mandatory attributes | not feasible without the EXPRESS schema | say so |
| QC01 storey naming | storeys indexed | regex per Table 6A: "Storey N"/"Level N", ordinals with correct suffix, "Mezzanine N", split floors with the same storey number, "Basement N", "Attic", "Upper/Lower Roof", `_block` suffix |
| QC02 clash detection | none | bounding-box pre-screen only, experimental |
| QC03 modelling inputs | presence and value in IFC values | add: property under the wrong set (warn, name the set), SGPset on the wrong entity, subtype under the wrong entity |
| QC04 room tagging | none | per-storey area heuristic first; true remaining area needs polygon booleans |
| QC05 coordinate alignment | georef per model kept | compare across files, MC wording |
| QC06 level consistency | URA 5.2 does same-name-different-FFL | add same-FFL-different-name across files |

Suggested module: `checks/cx-model-checker/` on the authority kit with the
index-only rules first, then QC03's structure checks inside IFC values, then
BCF-side parity (done), then the geometry heuristics.

## 3. Smaller items

- Discipline tag per model file in the project (the SP asks for it; QC05 and
  QC06 want to know which file is structural).
- "CORENET X" as an authority in scope.
- Results export beyond BCF (CSV of all findings).
- Snapshot per finding topic when the count is small.
- Undo for individual IFC edits.
- Preset ticks per project without writing the shared file.
