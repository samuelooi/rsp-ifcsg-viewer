/**
 * The check module contract.
 *
 * This file declares no runtime code — it is the reference for what a check
 * module must export, in one place, so a new authority module can be written
 * without reading the shell.
 *
 * Three rules make the framework hold together, and breaking them is what will
 * hurt later:
 *
 *  1. **`run` is pure.** Index in, findings out. No DOM, no viewer, no module
 *     globals. That is what lets a check be unit-tested against a fixture index
 *     and, later, moved into a Worker — the index is structured-cloneable.
 *  2. **The shell owns the 3D view.** A module never colours or hides anything
 *     itself; it asks, through `actions`, and the shell decides.
 *  3. **Metadata is static, implementation is lazy.** Everything the menu and
 *     the indexer need lives in the registry manifest, so nothing has to be
 *     downloaded to show a check or to know which IFC entities it needs.
 */

/**
 * @typedef {object} CheckManifestEntry  Static metadata, always in memory.
 * @property {string} id                 Stable slug, used in storage and results.
 * @property {string} title              Menu label.
 * @property {string} authority          Grouping in the menu: 'IFC-SG', 'URA', 'BCA'…
 * @property {string} summary            One line describing what it checks.
 * @property {CheckRequires} requires    What the model index must contain.
 * @property {boolean} [experimental]    Shown in the menu as not yet authoritative.
 * @property {boolean} [needsGeometry]   Reads mesh vertices, so it cannot move to a Worker yet.
 * @property {CheckInput[]} [inputs]     Extra input the user must supply.
 * @property {() => Promise<object>} load  Dynamic import of the module.
 */

/**
 * Something the check needs beyond the model — a cadastral lot file, a set of
 * surveyed coordinates. Declared in the manifest so the menu can render the
 * control without loading the check.
 *
 * @typedef {object} CheckInput
 * @property {string} id           Key it arrives under in `ctx.inputs`.
 * @property {'file'|'text'|'select'} kind
 * @property {string} label
 * @property {string} [accept]     File-picker filter, for `kind: 'file'`.
 * @property {string} [placeholder]
 * @property {Array<{value: string, label: string}>} [options]  For `kind: 'select'`.
 * @property {*} [default]         Supplied in `ctx.inputs` when the user leaves it alone.
 * @property {string} [help]       Shown under the control.
 */

/**
 * @typedef {object} CheckRequires
 * @property {string[]} [entities]  Upper-case IFC entities to index, e.g. ['IFCTANK'].
 * @property {boolean} [ruleset]    True if the check is driven by the IFC-SG ruleset,
 *                                  which contributes its own entities.
 */

/**
 * @typedef {object} CheckContext  Everything `run` is allowed to see.
 * @property {object} index        Merged model index (see ifc-index.js).
 * @property {object} ruleset      Indexed IFC-SG ruleset.
 * @property {Map<number,string>} modelNames  modelID -> file name.
 * @property {(target: object) => boolean} filter  Active agency/discipline scope.
 * @property {AbortSignal} signal  Aborted when the user cancels or loads a model.
 * @property {(msg: string, pct: number) => void} progress
 * @property {Object<string,*>} inputs  Whatever the user supplied for this check's
 *           declared inputs. A file arrives as `{ name, text }`, a text box as a string.
 * @property {THREE.Matrix4|null} coordinationMatrix  The re-centring the viewer applied,
 *           needed to get from scene coordinates back to real-world ones.
 * @property {CheckGeometry|null} geometry  Mesh vertices, for checks about *where*
 *           things are rather than what they are. Present only for a check whose
 *           manifest sets `needsGeometry`; it is the one part of the context that is
 *           not plain data, and the reason such a check cannot move to a Worker yet.
 */

/**
 * @typedef {object} CheckGeometry
 * @property {(modelID:number, expressID:number) => THREE.Vector3[]} elementPoints
 * @property {() => THREE.Vector3[]} modelPoints  Sampled across visible models.
 */

/**
 * @typedef {object} Finding  One thing worth telling the user about one element.
 * @property {object} element    An indexed element. Must come from `ctx.index`.
 * @property {string} severity   A value from SEVERITY. Drives counting and colour.
 * @property {string} code       Module-specific machine code, e.g. 'missing-pset'.
 * @property {string} label      Short human label for `code`.
 * @property {string} [message]  One sentence of detail.
 * @property {string} [rule]     Which requirement produced it, for traceability.
 */

/**
 * @typedef {object} CheckResult
 * @property {CheckSummary} summary  Headline numbers for the shell's summary bar.
 * @property {Finding[]} findings    Every finding. May be empty on a clean model.
 * @property {*} [detail]            Module-private data, passed back to `render`.
 * @property {string} [note]         Shown above the results, e.g. a scope caveat.
 */

/**
 * @typedef {object} CheckSummary
 * @property {number} elements   Elements the check looked at.
 * @property {number} assertions Individual assertions made.
 * @property {number} pass
 * @property {number} fail
 */

/**
 * @typedef {object} ShellActions  The only way a module may touch the app.
 * @property {(groups: ColourGroup[], title: string, subtitle?: string) => void} showInModel
 * @property {(element: object) => void} showElement
 * @property {(message: string) => void} toast
 * @property {(overlays: SurveyOverlay[]) => void} showSurvey  Draws survey polygons on
 *           the ground plane and frames them. Rings are in projected metres.
 */

/**
 * @typedef {object} SurveyOverlay
 * @property {string} label
 * @property {Array<[number,number]>} ring  Projected coordinates, e.g. SVY21 E/N.
 * @property {number} colour                0xRRGGBB
 */

/**
 * @typedef {object} ColourGroup
 * @property {string} label
 * @property {number} colour     0xRRGGBB
 * @property {object[]} elements
 */

/**
 * @typedef {object} CheckModule  The module's default export.
 * @property {(ctx: CheckContext) => CheckResult|Promise<CheckResult>} run
 * @property {(result: CheckResult, host: HTMLElement, actions: ShellActions) => void} [render]
 *           Module-specific results view. Without it the shell lists findings generically.
 * @property {(element: object, ctx: CheckContext) => Finding[]} [explain]
 *           Rows for the element inspector, evaluated live for one element.
 */

export {};
