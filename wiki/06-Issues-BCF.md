# Issues and BCF

The ISSUES tab reads and writes BCF 2.1, the format the CORENET X Model
Checker returns and that Revit and BCF viewers open. There is no library: the
zip container (`js/bcf/zip.js`, deflate through the browser's Compression
Streams) and the XML (`js/bcf/bcf.js`, DOMParser and XMLSerializer) are handled
in about 500 lines.

## Workflow

1. Set **Author** at the top of the tab; it stamps comments and new topics.
2. **Import BCF…** or drop a `.bcf` on the window. Topics list with type and
   status chips. Importing again with the same GUIDs updates rather than
   duplicates.
3. Select a topic. Its elements are coloured, from the viewpoint's components
   or from the 22-character GUID the Model Checker writes into the
   description, and the camera goes to the viewpoint where there is one, else
   frames the elements. An element the index did not keep (a column, a beam)
   is still found by GUID in the file text.
4. Change status or assignee, add comments. Every change stamps ModifiedDate
   and ModifiedAuthor.
5. **New topic** raises a topic on the element the inspector shows (or the
   query selection) with the current camera and a snapshot of the view.
6. **To BCF** on the Compliance tab creates a topic per fail or warn finding
   in the Model Checker's description format: requirement; message; GUID;
   file. Capped at 2000 to keep the file manageable.
7. **Export BCF** writes everything, named after the project code.

## Fidelity

Imported topics keep their original markup document; only the fields the
panel edits are changed and new comments are appended in schema order. Files in
the archive the panel does not understand (bcf.version, project.bcfp,
extensions, extra snapshots) are copied through unchanged, so a Model Checker
file survives a round trip.

## Coordinates

BCF viewpoints are in the IFC project coordinate system, metres, Z up. The
viewer's scene is the same coordinates re-centred by web-ifc's coordination
matrix and swapped to Y up: `scene = M · (x, z, −y)`. `Viewer.cameraViewpoint`
and `Viewer.setViewpoint` apply that mapping in both directions. A viewpoint
from a tool using a different convention may land off target; components are
resolved by GUID regardless.

## Severity mapping

| Viewer | BCF TopicType |
| --- | --- |
| fail | Fail |
| warn | Alert |
| info | Info |
