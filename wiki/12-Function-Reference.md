# Function reference

Every exported function in the codebase, plus `app.js`'s internal functions
grouped by feature (it has no exports — it is the entry script the page loads,
and everything in it is private module state and DOM wiring). Signatures are
copied from source, so a parameter list here is exact; the purpose is a
one-line summary, not the full doc comment — read the function's own comment
for the why.

Organised by file, in the order a developer is likely to need them: the model
layer first, then the app shell, then the feature modules, then the checks.

## `js/ifc-index.js` — the model index

| Function | Purpose |
| --- | --- |
| `readGeoreference(api, modelID)` | Reads one model's `IfcMapConversion`, `IfcProjectedCRS` and `IfcSite` lat/long, plus its length unit — everything the geo-referencing check and the dashboard need about where the model sits. |
| `buildIndex(api, modelID, ruleset, onProgress?)` | The main indexing pass: walks every entity the ruleset cares about, reads their property sets, resolves each element's storey, builds the aggregation map (parts of a geometry-less stair/roof/curtain-wall), reads element types (`typeName`/`typeTag`), and returns one model's index. |
| `mergeIndexes(indexes)` | Combines several per-model indexes (one federated submission) into the single index every query and check runs against. |

Element record shape (not a function, but the central data structure every
other module reads): `key`, `expressID`, `modelID`, `entity`, `canonicalEntity`,
`globalId`, `name`, `longName`, `objectType`, `predefinedType`, `tag`, `storey`,
`psets`, `hasGeometry`, `parts`, `hostKey`, `typeName`, `typeTag`.

## `js/ifcsg.js` — the ruleset

| Function | Purpose |
| --- | --- |
| `canonicalEntity(name)` | Upper-cases an entity name and folds a Revit "StandardCase" variant onto its base (`IfcWallStandardCase` → `IFCWALL`). |
| `appliesToAgency(target, agency)` | Does a rule target fall under an authority filter? Empty filter means any. |
| `loadRuleset(url?, overlayUrl?)` | Fetches `data/ifcsg-rules.json` plus the optional URA vocabulary overlay and indexes them. |
| `indexRuleset(raw, overlay?)` | Groups the flat workbook rows into one target per (gateway, agency, component, entity, subtypes) selector, merges the vocabulary overlay, and builds the entity/display lookups. |
| `describeSubtypes(subtypes)` | Human-readable subtype list for a tooltip, e.g. `"DOOR, GATE"` or `"all subtypes in COP"`. |
| `matchesTarget(el, target)` | Does one element satisfy a target's entity + subtype selector? |
| `selectElements(index, target)` | Every indexed element a target selects. |
| `findPset(el, name)` / `findProp(pset, name)` / `getValue(el, psetName, propName)` | Case-insensitive property-set and property lookup, since exporters vary on casing. |
| `formatValue(v)` / `formatNumber(n)` | Renders a value for display: `True`/`False` for booleans, rounded numbers with exporter float noise removed. |
| `isEmptyValue(v)` | True when a value carries nothing usable (`false` is a value, not a gap). |
| `evaluate(el, req, ruleset)` | Checks one requirement against one element; returns `{status, value, detail}` from the `STATUS` enum. |
| `runCheck(index, ruleset, filter?)` | Runs every requirement of every target with matching elements; returns per-target results plus totals. |
| `groupByValue(elements, req)` | Buckets a target's elements by one property's value, for colour-by-value; missing values get a `(not set)` bucket. |

## `js/viewer.js` — the 3D viewer

The `Viewer` class. Selected methods (the full list is in the source and the
[Architecture](09-Architecture.md) page's contracts section):

| Method | Purpose |
| --- | --- |
| `load(file, onProgress?)` | Parses an IFC file with web-ifc, builds the three.js mesh, applies the shared coordination matrix for federation, returns the model entry. |
| `releaseModelData(modelID)` | Frees the parsed wasm model once indexing is done, keeping only the rendered mesh. |
| `removeModel(modelID)` / `setModelVisible(modelID, on)` | Model lifecycle in the viewer. |
| `_geometryIds(el)` | The expressIDs that actually draw an element: itself, or its aggregated parts for a geometry-less stair/roof/curtain-wall. Every per-element mesh operation goes through this. |
| `setHidden(elements)` / `showAll()` / `isHidden(el)` | Hiding, implemented by collapsing triangles in the index buffer rather than removing geometry. |
| `setQuery(groups, contextMode)` / `setGroups(groups)` / `clearGroups()` | Colour overlays: one subset per legend group, built from `createSubset`. |
| `refresh()` | Reconciles the scene with the current models, hidden set and query groups — the one place colouring and hiding actually apply. |
| `elementPoints`, `elementHull`, `modelHull`, `groundLevel`, `elementYRange`, `sampleFloorY` | Geometry sampling for checks that ask about *where* things are (geo-referencing, storey floor levels). |
| `fitElements(elements)` | Frames the camera on a set of elements, resolving through their parts. |
| `cameraViewpoint()` / `setViewpoint(vp)` | Converts between the three.js camera and a BCF viewpoint (IFC project coordinates, metres, Z-up), via the coordination matrix. |
| `snapshot(maxWidth?, type?, quality?)` | Renders the current view to a PNG/JPEG blob, used by BCF topics and the readiness report. |
| `raycastFace(event)` | The face under the pointer with its normal snapped to the nearest world axis, for placing a section cut. |
| `addSectionAtFace(face, cameraPos)`, `grabSection`, `dragSection`, `flipSectionPlane`, `removeSectionPlane` | The section-cut tool: place on a clicked face, slide by dragging its handle, flip the kept side. |
| `enterPlanView()` / `exitPlanView()` / `setPlanClip(y)` | The orthographic plan-by-level view and its horizontal clip plane. |
| `_pickAt(event)` | Resolves a screen click to `{modelID, expressID}` through the raycaster, respecting active clipping planes. |

## `js/project.js` — the project settings file

| Function | Purpose |
| --- | --- |
| `emptyProject()` | A project document with every field at its default. |
| `normaliseProject(doc)` | Validates a parsed JSON document into the current shape; tolerant of missing fields so an older or hand-edited file still loads. |
| `parseProject(text)` | `JSON.parse` + `normaliseProject`, with a clear error on invalid JSON. |
| `looksLikeProjectFile(name)` | True for `*.json`, used to sort a project file out of a batch of dropped files. |
| `serialise(project)` | The file text, stable key order. |
| `fingerprint(project)` | A comparison key ignoring the `saved` timestamp, used to detect unsaved changes. |
| `labelOf(project)` / `suggestedFileName(project)` | Display label and the save picker's suggested name. |
| `saveToDisk(project, handle?, forcePicker?)` | Writes via `showSaveFilePicker` when available (save in place after the first pick), else downloads. |
| `openFromDisk()` | Opens via `showOpenFilePicker` or a plain file input. |
| `recentProjects()` / `rememberProject(project)` / `forgetRecent(key)` / `lastProject()` / `clearLastProject()` | The five-item recent list and last-used pointer kept in `localStorage`, stripped of findings to fit the storage quota. |

## `js/model-id.js` — what a model *is*

Built so a project's model records match files by content, never by name —
see [Project file](02-Project-File.md) for the reasoning and thresholds.

| Function | Purpose |
| --- | --- |
| `buildSketch(guids, k?)` | The bottom-*k* hash sketch of a set of GlobalIds — the compact fingerprint that stands in for "every element in this model". |
| `sketchSimilarity(a, b)` | Estimated Jaccard similarity of two sketches; `null` when either is too small to say anything. |
| `readHeader(file)` | Reads the STEP header (first 64 KB) for `FILE_NAME`, `FILE_SCHEMA` and the Revit `ContentGUID`/`VersionGUID`/`NumberOfSaves` fields, without parsing the file. |
| `buildIdentity(header, index, fileInfo)` | Combines the header, the model's element sketch and its spatial GUIDs into one identity record. |
| `compareIdentity(a, b)` | How alike two identities are: sketch overlap first, spatial-GUID overlap as the fallback for older records. Returns `{score, confidence, reasons}`. |
| `compareRevision(recorded, current)` | Has a matched model been re-issued since it was recorded (new VersionGUID, save number, size, element count)? |
| `bestMatch(identity, records)` | The record that best matches an identity, among several. |
| `describeIdentity(identity)` | A short human tooltip: export name, date, tool, schema, save number. |

## `js/ifc-text.js` — the STEP text layer

| Function | Purpose |
| --- | --- |
| `scanFile(file, onProgress?)` | One byte-level pass over the file recording every entity's start/end offset, every product GUID, the schema and where the DATA section ends. |
| `readLine(scan, id)` / `readLines(scan, ids)` | Reads one or many entity lines by id, batching into as few file reads as possible for a large set. |
| `parseLine(text)` | Parses `#12=IFCWALL('guid',#5,...);` into `{id, name, attrs}`. |
| `serialiseLine(line)` / `serialiseValue(v)` | The inverse: a `StepLine`/`StepValue` back to STEP text. |
| `NULL`, `ref(id)`, `str(v)`, `enumv(v)`, `num(n)`, `list(items)`, `typed(name, value)` | Constructors for the `StepValue` union used when building a new or edited line. |
| `encodeString(s)` / `decodeString(s)` | STEP string encoding: `''` for an apostrophe, `\X2\`/`\X\` escapes for non-Latin-1 characters, matching what Revit writes. |
| `plainValue(v)` | The plain JS value inside a (possibly typed) STEP value, for display. |

## `js/ifc-edit/` — editing the IFC

| Function | Purpose |
| --- | --- |
| `toStepValue(input, {dataType?, existing?})` | Builds the right STEP value (with its IFC type wrapper) for a user-typed string, inferring the wrapper from an existing value or the workbook's declared type. |
| `uuid()` (`guid.js`) | A random UUID v4, for BCF topic and comment ids. |
| `ifcGuid()` (`guid.js`) | A fresh 22-character IFC `GlobalId`, packed per the IFC spec. |

`IfcEditor` (the class): selected methods —

| Method | Purpose |
| --- | --- |
| `prepare(onProgress?)` | Scans the file and indexes every property-set relationship once, so sharing can be judged before any edit is made. |
| `elementPsets(elementId)` | The occurrence property sets attached to one element, with their properties. |
| `setProperty(element, pset, prop, value, {dataType?})` | Sets (or adds) one property, cloning the property set and/or its relationship first if either is shared with other elements ("clone on shared"). |
| `removeProperty(element, pset, prop)` | Removes a property; drops the whole set and its relationship if that empties it. |
| `moveProperty(element, fromPset, prop, toPset, {dataType?})` | Moves a property between sets, keeping its value and IFC type wrapper. |
| `setName(element, name)` | Renames any `IfcRoot` entity (how a storey is renamed). |
| `changedLines()` | Every line this session's edits will change, added or deleted, serialised. |
| `export()` | The edited file: original bytes with the changed lines spliced in, appended lines before `ENDSEC`. Never copies the file whole. |
| `validate(WebIFC, wasmPath)` | Re-parses just the changed lines in a throwaway web-ifc instance to catch a syntax slip before the download. |
| `discard()` | Forgets every edit made this session. |

## `js/bcf/` — BCF issues

`zip.js`:

| Function | Purpose |
| --- | --- |
| `crc32(bytes)` | CRC-32 for a zip entry. |
| `readZip(input)` | Reads every entry of a zip (stored or deflated) via the browser's `DecompressionStream`. |
| `writeZip(entries)` | Writes a zip, deflating text/XML and storing already-compressed files (PNG, nested zips). |

`bcf.js`:

| Function | Purpose |
| --- | --- |
| `readBcf(bytes)` | Parses a `.bcf`/`.bcfzip` into `{topics, extra, version}`, keeping each topic's original XML document for lossless re-write. |
| `writeBcf(bcf)` | Writes the archive back: edits topics' original documents in place, builds fresh XML for topics created here, passes unknown files through untouched. |
| `newTopic({title, ...})` / `newComment(author, text, viewpointGuid?)` / `newViewpoint({selection?, camera?, snapshotData?})` | Constructors for a topic raised in the viewer. |
| `touch(topic, author)` | Stamps `ModifiedDate`/`ModifiedAuthor` after an edit. |

## `js/report/` — the readiness PDF

`pdf.js`'s `PdfWriter` (no dependency — a minimal PDF 1.4 writer):

| Method | Purpose |
| --- | --- |
| `addPage()` | Starts a new page. |
| `textWidth(s, size, bold?)` | Advance width of a string, for wrapping and right-alignment. |
| `text(x, y, s, opts?)` | Draws text with its baseline at `y` from the page top. |
| `rect(x, y, w, h, opts?)` / `line(x1, y1, x2, y2, opts?)` | Filled/stroked boxes and rules. |
| `addJpeg(bytes, w, h)` / `image(name, x, y, w, h)` | Registers and draws a JPEG (DCTDecode, no re-encoding). |
| `build()` | Produces the final PDF bytes, including a correct cross-reference table. |

`report.js`: the internal `Flow` layout helper (headings, paragraphs,
key-values, page-breaking tables, signatures, footers) plus:

| Function | Purpose |
| --- | --- |
| `buildReadinessReport(data)` | The whole readiness report: verdict banner, project block, snapshot, models, per-check and per-rule tables, outstanding failures, warnings, hand edits, declaration. Derived entirely from check outcomes, so any check reports the same way. |

## `js/dashboard.js` — project quantities

| Function | Purpose |
| --- | --- |
| `computeDashboard(index, modelNames?)` | Every headline metric (GFA, parking, planting, …) totalled and broken down by file, level and type, against the CORENET X mapping. |
| `formatValue(value, decimals)` | Formats a metric total for display. |

## `js/memory.js` — the memory meter

| Function | Purpose |
| --- | --- |
| `resolveBudget()` | The renderer memory budget (4 GiB default, overridable with `?membudget=`). |
| `measure(viewer)` | Current estimate: geometry buffers + wasm heap + JS heap, against the budget. |
| `project(current, files)` | Forecasts the peak memory a set of files about to be loaded will need, before parsing starts. |
| `levelFor(ratio)` | Maps a usage ratio to `LEVEL.OK`/`WARN`/`DANGER`. |
| `formatBytes(n)` | Human-readable byte size. |

## `js/geo/` — coordinates

| Function | Purpose |
| --- | --- |
| `buildTransform(georef, coordinationMatrix)` (`georef.js`) | Builds `sceneToSvy21`/`svy21ToScene` functions from a model's `IfcMapConversion`, undoing the Y-up axis swap and the coordination re-centring. |
| `describeGeoreference(georef, transform)` (`georef.js`) | Human-readable summary of a model's geo-referencing for the check report. |
| `lonLatToSvy21(lon, lat)` / `svy21ToLonLat(E, N)` (`svy21.js`) | WGS84 ↔ SVY21 (EPSG:3414) projection. |
| `withinSvy21Bounds(E, N)` (`svy21.js`) | Sanity check that a coordinate is plausibly within Singapore. |
| `compoundAngleToDegrees(parts)` (`svy21.js`) | Converts an `IfcCompoundPlaneAngleMeasure` to decimal degrees. |
| `parseCadastralGeoJson(text)` / `parseVertices(text)` (`geojson.js`) | Reads a URA cadastral-lot GeoJSON, or a pasted list of surveyed vertices. |
| `signedArea`, `area`, `centroid`, `bounds`, `pointInRing`, `distanceToRing`, `signedDistanceToRing`, `convexHull`, `simplify` (`polygon.js`) | 2D polygon geometry used by the geo-referencing check's hull comparison. |

## `js/checks/` — the check framework

| Function | Purpose |
| --- | --- |
| `all()` / `byId(id)` / `byAuthority()` (`registry.js`) | The static manifest — every check's metadata without loading its module. |
| `requiredEntities()` (`registry.js`) | Every IFC entity any check might need, for the indexer's entity union. |
| `customInputs()` (`registry.js`) | Every `kind: 'custom'` input across all checks (the value-preset editor is the only one today). |
| `load(id)` (`registry.js`) | Dynamically imports a check's module, cached for the session. |
| `runChecks(ids, ctx, onProgress?)` (`runner.js`) | Runs the selected checks in order, in a try/catch per check so one broken module does not stop the others. |
| `allFindings(outcomes)` / `totalsOf(outcomes)` (`runner.js`) | Flattens findings across outcomes; sums pass/fail/warn. |
| `createAuthorityCheck(config)` (`authority-kit.js`) | Factory that turns a flat rule list (URA, BCA) into a full check module, with per-rule pass/fail statistics the report table reads. |
| `worstOf(severities)` / `isFailure(severity)` (`severity.js`) | Severity ordering helpers. |

### Check modules

Each exports `{run, render, explain}` (see [Compliance checks](04-Compliance-Checks.md)):

| Module | `run` does | Notable extra exports |
| --- | --- | --- |
| `space-geometry/index.js` | Filters `IFCSPACE` for `hasGeometry === false`, sorted and grouped by Area_GFA vs other. | — |
| `ifc-values/index.js` | Runs `runCheck` from `ifcsg.js` plus every enabled value preset. | `presets.js` — `normalisePreset`, `matchesPreset`, `testElement`, `runPreset`, `psetCatalog`, `distinctValues`, `subtypeCatalog`; `preset-store.js` — `loadPresets`, `savePresets`, `canSave`; `preset-editor.js` — the custom-input module (`mount`, `value`, `requiredEntities`). |
| `geo-referencing/index.js` | Compares the model's hull (via `viewer.elementHull`) against a cadastral lot or surveyed vertices, in SVY21. | — |
| `ura/index.js` + `rules.js` | Twenty rules from the URA guide, built with `createAuthorityCheck`. | `gatewayOf(ctx)`, `ura(el, parameter)`, `areaGfa(ctx)`, `RULES`. |
| `bca/index.js` + `rules.js` | Placeholder — `RULES` is empty. | — |

## `js/util/dom.js`

| Function | Purpose |
| --- | --- |
| `esc(s)` | HTML-escapes a string for safe interpolation into `innerHTML`. |
| `hex(n)` | A `0xRRGGBB` number to a CSS `#rrggbb` string. |

## `js/app.js` — the app shell (internal, no exports)

Grouped by feature, in the order they appear in the file.

**Boot and top bar**
`toast`, `setProgress`, `renderMemory`, `init`, `loadCustomInputs`, `wireUI`.

**Section cuts and plan levels**
`setSectionArmed`, `wireSectionTool`, `renderSectionsBar`, `storeyGroups`,
`computeLevels`, `wireLevelsTool`, `openLevelsPanel`, `closeLevelsPanel`,
`enterPlan`, `exitPlan`, `renderPlanBadge`.

**Loading models**
`loadFiles`, `rebuildIndex`, `renderModels`, `removeModel`.

**Visibility**
`spaceElements`, `applyVisibility`, `setSpacesVisible`, `showAll`,
`hideElements`, `isolateElements`, `openContextMenu`, `closeContextMenu`.

**Query tree (QUERIES tab)**
`matchesSecondaryFilters`, `inScope`, `visibleTargets`, `refreshFilters`,
`renderBubbles`, `renderGatewayBubbles`, `setGateway`, `renderAgencyBubbles`,
`componentGroups`, `groupElements`, `elementKind`, `groupProperties`,
`propertyElements`, `renderTree`, `selectComponent`, `selectProperty`,
`clearQuery`, `renderLegend`, `applyOverlay`.

**Compliance tab**
`clearCheckResults`, `loadSelection`, `saveSelection`, `renderCheckMenu`,
`renderCheckInputs`, `wireCheckInputs`, `inputsFor`, `updateRunButton`,
`doRunCheck`, `renderSummary`, `renderCheckResults`, `renderGenericFindings`,
`colourByStatus`.

**Dashboard**
`openDashboard`, `renderDashboard`, `showMetricInModel`.

**Element inspector**
`pickedElement`, `onPick`, `showElement`.

**Project file**
`checkInScope`, `collectProject`, `applyProject`, `applyPresetTicks`,
`restoreLastProject`, `openProjectFile`, `openProjectPicker`, `newProject`,
`saveProject`, `projectDirty`, `renderProjectChip`, `openProjectPanel`,
`renderProjectPanel`, `renderStartProjects`, `wireProjectUI`.

**Tabs**
`showTab`.

**IFC editing**
`canEdit`, `textScanFor`, `editorFor`, `editProperty`, `renameElement`,
`afterEdit`, `renderEditsBar`, `editLogsByFile`, `acceptedOptions`,
`openInlineEdit`, `exportEdits`, `saveBlob`, `discardEdits`, `openLegendEdit`,
`wireEditingUI`.

**BCF issues**
`bcfAuthor`, `renderBcfList`, `selectTopic`, `topicGuids`, `resolveGuids`,
`showTopicInModel`, `renderBcfDetail`, `importBcfFile`, `newTopicFromSelection`,
`findingsToBcf`, `exportBcf`, `wireBcfUI`.

**Model records**
`dashboardForModel`, `buildModelRecord`, `captureModelRecords`,
`reconcileModels`, `modelSubtitle`, `submissionTotals`, `submissionDashboard`.

**Readiness report**
`makeReport`.
