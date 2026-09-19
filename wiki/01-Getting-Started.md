# Getting started

## Run it

The page uses ES modules and fetches JSON, so it must be served over HTTP.
There is no build step and no Node.

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8080
```

Open <http://localhost:8080>. The server also exposes the shared value presets
file at `/api/presets`, which is what lets the preset editor and project ticks
save. On a plain static host everything else works and presets are read-only.

Chrome or Edge are recommended: they have the native save picker (save in
place, Save as…) used by the project file, IFC export, BCF and PDF. Other
browsers download instead.

## Load models

Drop one or more `.ifc` files on the window, or use **Add IFC file**. Several
files are treated as one federated model: the first file establishes the datum
and later files are placed against it. Nothing is uploaded; parsing happens in
the browser with web-ifc.

A project file (`*.ifcsg-project.json`) and a BCF (`*.bcf`) can be dropped in
the same gesture. The project is applied before the models index.

Memory is the constraint. The meter in the top bar estimates the tab's use
against a 4 GB budget; a 170 MB file needs roughly ten times that in geometry.
Close a model before adding another when the meter goes amber.

## The screen

- **Top bar.** Loaded models (click for the list), the project chip, memory
  meter, ruleset badge, Dashboard, Reset view, Add IFC file.
- **Left panel, three tabs.** QUERIES colours the model by component or
  property. COMPLIANCE selects and runs checks and holds the results, the BCF
  and PDF buttons. ISSUES holds BCF topics.
- **Tool rail.** Collapse panel, spaces on/off, survey outlines, show all,
  ghost context, wireframe, fit, section cut, plan by level.
- **Right panel.** The element inspector: identity, aggregate host, live
  pass/fail for every loaded check, property sets with Edit buttons.
- **Bottom centre.** The edits bar appears when there are pending IFC edits.

## A typical session

1. Open or create the project (chip in the top bar): code, name, gateway,
   authorities, cadastral lot.
2. Drop the IFC files.
3. Compliance → Run. Read the summary; click a result row to colour the model.
4. Fix what can be fixed in the inspector or the legend; Export IFC.
5. To BCF, then Export BCF for the Model Checker or the team.
6. PDF report, sign, file with the submission.
7. Save the project so the next run starts from the same context.
