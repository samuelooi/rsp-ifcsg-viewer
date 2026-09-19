# RSP IFC-SG Viewer & Checker — Wiki

Written for the RSP BIM team and whoever maintains the tool next. Copy these
pages into the GitHub wiki, or read them here.

## Pages

1. [Getting started](01-Getting-Started.md) — run it, load models, the screen.
2. [Project file](02-Project-File.md) — what is saved, how it drives the checks.
3. [Viewer and queries](03-Viewer-and-Queries.md) — controls, section cuts, colour-by-property.
4. [Compliance checks](04-Compliance-Checks.md) — every check, what it asks, how to read the results.
5. [Editing the IFC](05-Editing-IFC.md) — fixing properties in the file, safely.
6. [Issues and BCF](06-Issues-BCF.md) — exchanging with the CORENET X Model Checker.
7. [Readiness report](07-Readiness-Report.md) — the PDF and its verdict.
8. [Testing](08-Testing.md) — headless verification against real models.
9. [Architecture](09-Architecture.md) — modules, data flow, the contracts.
10. [Process log](10-Process-Log.md) — the September 2026 build, start to finish.
11. [Roadmap](11-Roadmap.md) — designed but not built, and the Model Checker MVP mapping.
12. [Function reference](12-Function-Reference.md) — every exported function by file, plus app.js's internals grouped by feature.

## One-paragraph summary

The viewer loads IFC-SG submission files in the browser, indexes every element
the CORENET X mapping queries, and lets a modeller see any component or
property in 3D. The Compliance tab runs authority checks over the same index.
A project file keeps the submission context so the run is repeatable. Property
gaps can be fixed in a copy of the IFC without touching any other byte.
Findings go to the authorities' format (BCF) and to a signed-off PDF. Nothing
leaves the machine.
