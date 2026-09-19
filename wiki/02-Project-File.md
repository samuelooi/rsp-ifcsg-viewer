# Project file

A project is "what we are submitting, to whom, at which gateway". Those three
facts decide most of a compliance run, so they live in one file next to the
IFC set: `<code>.ifcsg-project.json`. The format is in `js/project.js`.

## Contents

```json
{
  "format": "rsp-ifcsg-project",
  "version": 1,
  "project": { "code": "250008", "name": "Sin Ming Blk 32", "developer": "HDB",
               "lots": ["MK18-01234A"], "files": ["...-MAIN-XX-0001.ifc"] },
  "submission": { "gateway": "construction", "authorities": ["URA", "BCA", "SCDF"] },
  "checks": {
    "selected": ["ifc-values", "geo-referencing", "ura"],
    "inputs": { "geo-referencing.cadastralLot": { "name": "MK18-01234A.geojson", "text": "{...}" } },
    "presets": ["ceiling-height"]
  },
  "ruleset": { "generated": "2026-09-18T07:42:28+08:00" },
  "edits": { "...-MAIN-XX-0001.ifc": [ { "op": "set", "pset": "Pset_StairCommon", "prop": "FireExit", "from": false, "to": true, "..." : "..." } ] },
  "saved": "2026-09-18T11:05:00+08:00"
}
```

| Block | Effect when applied |
| --- | --- |
| `submission.gateway` | Sets the query tab's gateway filter and the URA check's gateway selector. One setting, so they cannot disagree. |
| `submission.authorities` | Scopes the query tab's authority bubbles, the IFC values check's targets and the check menu. Ticking or unticking an authority in the panel ticks or unticks its checks. Empty means all. |
| `checks.selected` | The ticked checks. A file without the field ticks every non-experimental check in scope. |
| `checks.inputs` | The check inputs by `<check>.<input>`; files are embedded as text so the project survives being emailed. |
| `checks.presets` | Which shared value presets are ticked, by id. Applying writes the ticks to the shared file through the dev server. |
| `project.files` | Expected model files, recorded on save. The panel shows which are loaded. |
| `ruleset.generated` | The workbook stamp. A different stamp at load gives a one-line warning. |
| `edits` | Hand edits made in the viewer, by file. Informational; not re-applied. |

Not in the file: hidden elements, section cuts, colours, camera. Those are
session scratch.

## Model records

`models` holds one record per model the project has checked:

```json
{ "id": "m1", "name": "…-BLDG-55.ifc",
  "identity": { "sketch": [12, 57, …], "siteGuids": [], "buildingGuids": [], "storeyGuids": [],
                "projectGuid": "…", "contentGuid": "…", "versionGuid": "…", "saves": 1161,
                "headerName": "…-BLDG-01.ifc", "exportedAt": "2026-09-11T17:53:49+08:00",
                "authoringTool": "Autodesk Revit …", "schema": "IFC4",
                "bytes": 59060406, "elements": 4826, "storeyCount": 41 },
  "checkedAt": "2026-09-19T…", "rulesetGenerated": "…",
  "elements": 4826, "storeys": [{ "name": "…", "elevation": 0 }],
  "georef": { "hasMapConversion": true, "eastings": …, "crs": "…" },
  "dashboard": [{ "id": "gfa", "title": "Gross Floor Area", "unit": "m²", "total": 1234.5, "count": 88 }],
  "checks": [{ "id": "ifc-values", "title": "IFC values", "authority": "IFC-SG",
               "status": "fail", "fail": 4625, "warn": 0,
               "elements": 4826, "assertions": 25392, "pass": 20767, "scope": "file" }],
  "findings": [{ "check": "…", "guid": "…", "name": "…", "entity": "…",
                 "severity": "fail", "code": "…", "label": "…", "message": "…", "rule": "…" }],
  "findingsTruncated": 0 }
```

That is what lets a submission be checked one file at a time on a machine that
cannot hold every file at once. The project panel's **Models** list shows the
records against what is loaded now, and the note beneath totals the submission.

`scope` says how far a check row's numbers reach. `file` means the model was
checked on its own, so the run's totals describe it alone. `shared` means
several files were open, so only the failures and warnings attributable to this
model's elements are counted; submission-level findings (file size, levels
across files) belong to the run, not to one file.

### Identity: why not the file name

Submission files get renamed, and a re-export keeps the name while changing
everything inside. Matching is therefore on content (`js/model-id.js`):

| Signal | Role |
| --- | --- |
| Element sketch: the 256 smallest hashes of the model's element GlobalIds | The identity. Same model re-exported ≈ 1; different models ≈ 0.0003 on the sample files |
| Site, building and storey GlobalIds | Corroboration, and the fallback for records written before sketches existed |
| IfcProject GUID, Revit ContentGUID | Shared across a whole Revit project, so recorded but never matched on |
| VersionGUID, save number, export time, size, element count | Whether a matched file has been re-issued |

Thresholds: a sketch overlap of 0.35 or more is the same model, 0.12 to 0.35
is "likely" and is surfaced with its reason. The spatial fallback needs 0.7
plus a matching export name, because blocks from one Revit model share the
site, the building shell and often several levels — on the sample files two
different blocks reach 0.46 on spatial GUIDs alone, which is why the sketch
decides.

## Using it

- **Project chip** in the top bar opens the panel. **New** starts blank.
  **Open…** uses the picker. **Save** writes in place once a location is
  chosen; **Save as…** picks another. The amber dot means unsaved changes.
- **Drop** a project file on the window, alone or with the IFCs.
- The **start card** lists the five most recent projects and restores the last
  one automatically on the next visit (kept in browser storage, stripped to
  what fits).
- Leaving the page with unsaved changes prompts.

## Design notes

Embedding the cadastral lot was chosen over referencing it by path: a file
that carries its inputs can be handed to a colleague. Lots are rarely more
than a few hundred kilobytes.

The recent list in browser storage has a 5 MB ceiling; if per-model results
are added to the file later (see Roadmap) the stored copy must be stripped of
them.
