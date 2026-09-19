# Editing the IFC

Last-mile fixes on the day of submission: set a property a check found
missing or wrong, change any value in the inspector, rename a storey, or set
one property on every element a query selected. The result is a copy of the
file that differs from the original only in the edited lines.

The durable fix belongs in Revit. The next export overwrites these edits; the
edits bar, the project file's log and the report all say so.

## Where the buttons are

- **Inspector.** A failing IFC-SG requirement shows **Fix** (booleans and
  enumerations come as a list of accepted values, the workbook's data type
  decides the IFC value type). Every property row shows **Edit**. **Rename**
  changes the Name attribute of any element, which is how a storey is renamed.
- **Query legend.** A property query shows **Set value…**, applied to every
  element the legend lists; a soloed row narrows it.
- **Edits bar** at the bottom counts pending edits. **Export IFC** validates
  and writes `<name>-edited.ifc` per file; **Discard** forgets them.

Values show immediately in the inspector, legend and checks because the edit
is mirrored into the in-memory index as well as recorded as a patch.

## How it works

`js/ifc-text.js` scans the file the browser still holds, once, recording every
entity's byte range, every product GUID, the schema and where the DATA section
ends. It is a byte state machine, so a 170 MB file takes a few seconds and two
typed arrays.

`js/ifc-edit/editor.js` reads the property relationships once to know what is
shared, then edits through patches: replace line N, delete line N, append new
lines with fresh express ids and fresh IFC GUIDs. Export slices the original
bytes around the patches, so untouched lines are byte-identical and the file is
never copied whole. Before the download, the changed lines are re-parsed by
web-ifc on a small file made of just them.

**Clone on shared.** Revit writes a property value once and references it from
every set with the same value, and attaches one set to many elements through a
single relationship. Changing such a line in place would change every element
sharing it. So before writing, the editor detaches the element from a shared
relationship, clones a shared property set, and clones a shared property, and
only then writes. The verification on ADM1 showed exactly this: a FireExit line
shared across sets was cloned for the edited stair while another stair kept
its value; an unshared NumberOfRiser was patched in place.

## Limits

- Occurrence property sets only. A property that exists only on the type gets
  an occurrence-level copy, which authorities read, but the type is unchanged.
- No geometry edits. No undo beyond Discard.
- Removing a model drops its pending edits, with a toast.
