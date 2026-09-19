# Architecture

## Data flow

```
IFC file (File, kept)
   │  web-ifc parse (geometry + lines)          ─┐
   ├─ viewer.load ──► three.js mesh, subsets     │ released after indexing
   └─ buildIndex ───► elements, psets, storeys,  │ (memory)
                      georef, parts, types      ─┘
                          │
        mergeIndexes ─────┴──► index (byId, byEntity, byGuid, storeys, hostOf)
                                  │
   ruleset (workbook JSON) ──► queries (targets → elements → colour groups)
                                  │
   registry manifest ─────────► runChecks(ctx) ──► outcomes (summary, findings, detail)
                                  │                     │
   project file ◄──── state ──────┤                     ├──► results UI, colour by status
                                  │                     ├──► BCF topics ──► bcfzip
                                  │                     └──► readiness PDF
   ifc-text scan (from the File) ─┴──► editor patches ──► edited IFC (byte splice)
```

## Modules

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `app.js` | State, UI wiring, project apply/collect, editing UI, issues UI, report hook | everything below |
| `viewer.js` | three.js scene, OrbitControls, subsets for colour, index-buffer hiding, section planes, camera viewpoints, snapshots | three, web-ifc-three |
| `ifc-index.js` | Per-model index from web-ifc lines; merge for federation | web-ifc, ifcsg (aliases) |
| `ifcsg.js` | Ruleset loading and indexing, target matching, evaluation, gateways | — |
| `project.js` | Project schema, validation, serialise, disk and browser storage | — |
| `checks/registry.js` | Static manifest, lazy module loading, entity union | — |
| `checks/runner.js` | Runs selected checks in order with abort and progress | registry |
| `checks/authority-kit.js` | Rule-driven check factory (URA, BCA) with per-rule stats | severity |
| `checks/<id>/` | One check each; `run` pure, `render` DOM, `explain` for the inspector | — |
| `ifc-text.js` | Byte scan of the STEP file; STEP value parse/serialise; string encoding | — |
| `ifc-edit/editor.js` | Element psets, edits with clone-on-shared, export, validation | ifc-text, guid |
| `bcf/zip.js`, `bcf/bcf.js` | Zip read/write; BCF topics, viewpoints, comments | Compression Streams |
| `report/pdf.js`, `report/report.js` | PDF writer; flow layout and readiness content | — |
| `dashboard.js`, `memory.js`, `geo/` | Quantities, memory meter, SVY21 and georeference maths | — |

## Contracts worth knowing

- **Element record** (`ifc-index.js`): `key` (`modelID:expressID`), `entity`,
  `canonicalEntity`, `globalId`, `name`, `longName`, `objectType`,
  `predefinedType`, `tag`, `storey`, `psets` (name → prop → value),
  `hasGeometry`, `parts` (descendant express ids that draw it), `hostKey`,
  `typeName`, `typeTag`.
- **Check module** (`checks/types.js`): `run(ctx) → { summary, findings, detail?, note? }`;
  `render(result, host, actions)`; `explain(element, ctx) → findings`. A
  finding is `{ element, severity, code, label, message?, rule?, req? }`.
- **Shell actions** given to a check: `showInModel(groups, title)`,
  `showElement(el)`, `toast(msg)`, `showSurvey(overlays)`.
- **Geometry ids**: any per-element mesh operation goes through
  `viewer._geometryIds(el)` so aggregates resolve to their parts.
- **Coordinates**: scene = `M · (x, z, −y)` of IFC project coordinates in
  metres, `M` the coordination matrix from the first model loaded.

## Why some things are the way they are

- The parsed IFC is released after indexing to keep several files affordable;
  anything that needs the file again (editing, GUID lookup) reads the File
  object the browser still holds, never a copy in memory.
- Edits are patches over bytes, not a rewrite, so a submission file changes
  only where the user changed it and validates against what was exported.
- Checks are lazy modules with static metadata so the menu and the indexer
  never have to download a check to know it exists or which entities it needs.
- No dependencies beyond three.js and web-ifc: zip, BCF XML, PDF and STEP are
  hand-written and small, which keeps the tool runnable from any static host
  and free of supply-chain surprises.
