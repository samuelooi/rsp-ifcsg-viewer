# Readiness report

**PDF report** on the Compliance tab writes `<code>-readiness-report.pdf`
after a run. It is the record that the models were checked and whether they
are ready to submit, for the QP to sign and file.

## Format

1. **Verdict banner.** READY FOR SUBMISSION (green) or NOT READY (red) with
   the counts. Ready means every selected check ran and produced no failure.
   Warnings are listed but do not block. No checks run means not ready.
2. **Project.** Code, development, developer, lots, gateway, authorities in
   scope, the IFC-SG workbook and its generation stamp, prepared by (the
   Author field on the Issues tab), generated when.
3. **Snapshot** of the current view, JPEG.
4. **Model files checked.** Name, size, elements indexed; a note that several
   files were checked as one federated model.
5. **Checks.** One row per check: elements, assertions, pass, fail, warn,
   result. Checks not selected are listed as not run so the verdict's scope is
   explicit; experimental checks are marked "no rules yet".
6. **Per check.** Rule-based checks (URA, BCA) get a rule table with the guide
   reference, tested, failed and result; other checks get failures and
   warnings by component with the most frequent issue.
7. **Outstanding failures.** Up to 150 rows with check, element, GlobalId and
   issue, then a pointer to the BCF export for the rest.
8. **Warnings**, up to 60.
9. **Edits made in the viewer**, if any, with the reminder that they live in
   the IFC copy only.
10. **Declaration** and signature lines: prepared by, reviewed by (QP), date.
    The wording mirrors the CORENET X Model Checker guide: the report
    supplements the QP's review and does not replace it.

Every page carries a footer with the project, the generation time and the page
number.

## Implementation

`js/report/pdf.js` is a small PDF 1.4 writer: the two base Helvetica faces in
WinAnsi (no font embedding, so dashes, bullets and quotes map and anything else
becomes "?"), rules, filled boxes, JPEG images by DCTDecode, a correct
cross-reference table. `js/report/report.js` is a flow layout (headings,
paragraphs, key-values, tables that break across pages with the header
repeated, signatures, footers) and the readiness content, derived from the
check outcomes alone so every check reports the same way.

## Changing the wording

The declaration paragraph, section headings and verdict text are string
literals in `report.js`. The column widths are in points per table.
