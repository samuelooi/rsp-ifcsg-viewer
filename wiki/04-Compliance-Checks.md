# Compliance checks

The COMPLIANCE tab lists every check in `js/checks/registry.js`, grouped by
authority. Tick the checks, supply their inputs, Run. Each check renders its
own results; clicking a result row colours the model; **Colour** paints the
whole model by status.

| Check | Authority | What it asks | Inputs |
| --- | --- | --- | --- |
| IFC values | IFC-SG | Every mapped element carries the property sets, properties and accepted values the CORENET X mapping requires, within the project's gateway and authority scope. Plus the team's value presets. | Preset ticks |
| Geo-referencing | URA | The model sits on the cadastral lot: IfcMapConversion read back, model hull compared with the lot polygon in SVY21. | Cadastral lot GeoJSON, or three surveyed vertices |
| URA requirements | URA | Twenty rules from the URA Revit Model Quality Checker guide, section 7: core parameters populated (thresholds differ by gateway), GFA sanity rules, required objects present, file size, level consistency, export fingerprints. | Gateway (follows the project) |
| Space geometry | IFC-SG | Every IfcSpace has a geometric representation; Area_GFA spaces without one are counted separately. Table and CSV in the community checker's columns. | none |
| BCA requirements | BCA | Placeholder, no rules yet. | none |

## Reading results

- **Fail** is what an authority would reject. **Warn** may be intentional or
  the mapping leaves it open. **Info** is worth knowing. **Pass** is a checked
  and satisfied assertion.
- A check that asserted nothing reports "nothing checked", never "clean".
- Every element's inspector shows live pass/fail from every loaded check, so a
  fix can be confirmed without re-running.

## Scope

The project's gateway and authorities decide which targets the IFC values
check evaluates and which checks are ticked by default. The Design Gateway asks
for far less than the Construction Gateway; the selector defaults to
Construction so a forgotten choice over-reports rather than skips.

## After the run

- **To BCF** turns every fail and warn finding into a topic on the Issues tab.
- **PDF report** writes the readiness report.
- **Fix** buttons appear in the inspector on failing IFC-SG requirements.

## Adding a check

Create `js/checks/<id>/index.js` exporting `{ run, render, explain }` as the
default export, then add one manifest entry to the registry with the entities
it needs. The manifest is static so the menu and the indexer know about the
check without loading it; the module is fetched on first run. `run` is pure
(index in, findings out), the shell owns the 3D view, and `types.js` is the
contract. Rule-driven authority checks use `authority-kit.js` and get the
per-rule results the report prints for free.
