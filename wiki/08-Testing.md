# Testing

There is no unit test runner and no Node on the development machine. Features
are verified by driving the real app in headless Chrome against real
submission files, and by direct module tests in a plain page.

## Test models

Local copies in `C:\Users\<you>\Downloads` and `Documents`:

| File | Size | Use |
| --- | --- | --- |
| `X-XCIP-A-ADM1-00-BLDG-55.ifc` | 59 MB | The quick one: 4826 mapped elements, 48 stairs, 477 spaces. Loads in 1–2 minutes headless. |
| `X-XCIP-A-CUP1-00-BLDG-55.ifc` | 166 MB | The heavy one: 49 stairs, 4 spaces without geometry. 7+ minutes per headless run. |
| `ABCD-RSP-AR-BIM-BLK1-XX-901000.ifc` | 4 MB | Tiny; a copy with one space's Representation blanked is the space-geometry fixture. |

## The harness recipe

1. Copy `js/`, `data/` and `index.html` to a scratch folder with the model as
   `model.ifc`.
2. Append to the copied `app.js` a `window.__dbg` getter exposing the module
   state you need (`viewer`, `index`, `checkOutcomes`, `editProperty`, …).
3. Write a harness script that waits for the ruleset badge, fetches the model,
   wraps it in a `File`, puts it in a `DataTransfer` and dispatches a
   synthetic `drop` on `window`, then drives the UI by clicking buttons and
   dispatching input events, logging with a `[tag]` prefix.
4. Make a page from the copied `index.html` with the harness script injected
   before `</body>`.
5. Serve the scratch folder: `tools/serve.ps1 -Port 8094 -Root <folder>`.
6. Run Chrome:

```
chrome.exe --headless=new --disable-gpu --use-gl=swiftshader --no-sandbox
  --window-size=1600,1000 --virtual-time-budget=900000
  --user-data-dir=C:/Users/<short>/AppData/Local/Temp/cpN
  --enable-logging=stderr --v=0 --screenshot=out.png http://localhost:8094/page.html 2> run.log
```

7. Read the log: `grep -o "\[tag\].\{0,600\}" run.log | sed 's/", source:.*//'`.

## Traps

- Under the virtual clock a page is kept alive only by pending timers: poll
  with `setTimeout` loops or a `setInterval` keep-alive, or Chrome exits after
  `load` before async work finishes. `Date.now()` deltas are virtual.
- An `<img>` on a blob URL never finishes loading under the virtual clock and
  freezes every timer. Stub `URL.createObjectURL` to a data URL in harnesses.
- Hundreds of `CompressionStream` pipelines (a 2000-topic BCF) stall under
  the virtual clock; cap the data.
- A long `--user-data-dir` path under the scratchpad breaks Chrome's GPU cache;
  use a short one.
- `grep "[^\"]*"` truncates at the first quote inside a message and looks
  like a failure; use the recipe above.
- The dev server handles one download at a time: never run two harnesses
  that fetch a model concurrently.
- A `const d = window.__dbg` snapshot copies scalar state; call the getter
  again for live values.
- To get a generated file out of the page, PUT it as JSON to `/api/presets`:
  the server writes it to `data/value-presets.json` in the served root.

## Direct module tests

`ifc-edit/editor.js` and the BCF layer can be exercised without the viewer in
a page that imports them and fetches the model as a File. That is how the
export was validated: re-open the exported bytes in a fresh web-ifc instance
and read the new lines back by id.
