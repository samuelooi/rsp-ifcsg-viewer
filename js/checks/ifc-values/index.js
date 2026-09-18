/**
 * IFC values check — does the model carry the data the CORENET X mapping asks for?
 *
 * This is a data check, not a building check. It answers "is this submission
 * populated correctly", not "is this building compliant". Every assertion comes
 * from the generated ruleset, so nothing here hard-codes a requirement.
 *
 * The authority checks (URA, BCA) are the other half: they read the values this
 * check validates and test them against the rules the agencies publish.
 *
 * The user's own value presets (presets.js) run here too. They arrive as the
 * `presets` input and are reported in their own section, ahead of the mapping.
 */

import {
  runCheck, evaluate, matchesTarget,
  STATUS, STATUS_LABEL, formatValue, isEmptyValue,
} from '../../ifcsg.js';
import { SEVERITY } from '../severity.js';
import { esc, hex } from '../../util/dom.js';
import {
  RESULT, RESULT_LABEL, RESULT_COLOUR,
  runPreset, testElement, matchesPreset, describePreset,
} from './presets.js';
import { enabledPresets } from './preset-store.js';

/**
 * Per-status colours. These live here rather than in the shell because they are
 * this check's vocabulary — another module's codes mean different things.
 */
const STATUS_COLOUR = {
  [STATUS.PASS]: 0x5aa65a,
  [STATUS.MISSING_PSET]: 0xd16a4f,
  [STATUS.MISSING_PROP]: 0xc4563c,
  [STATUS.EMPTY]: 0xb0763c,
  [STATUS.INVALID_VALUE]: 0xd4a13c,
  [STATUS.INVALID_TYPE]: 0xc06c84,
};

/**
 * How this check's statuses map onto the shared severity vocabulary.
 *
 * Every non-pass status is a FAIL today, which matches how the app has always
 * reported them. This table is the one place to soften that — making EMPTY a
 * WARN, say — without touching the evaluator or the shell.
 */
const SEVERITY_OF = {
  [STATUS.PASS]: SEVERITY.PASS,
  [STATUS.MISSING_PSET]: SEVERITY.FAIL,
  [STATUS.MISSING_PROP]: SEVERITY.FAIL,
  [STATUS.EMPTY]: SEVERITY.FAIL,
  [STATUS.INVALID_VALUE]: SEVERITY.FAIL,
  [STATUS.INVALID_TYPE]: SEVERITY.FAIL,
};

/** @type {import('../types.js').CheckModule} */
const module = {
  run(ctx) {
    const raw = runCheck(ctx.index, ctx.ruleset, ctx.filter);

    const findings = [];
    const elementKeys = new Set();

    for (const target of raw.targets) {
      for (const el of target.elements) elementKeys.add(el.key);
      for (const issue of target.issues) {
        findings.push({
          element: issue.element,
          severity: SEVERITY_OF[issue.status] || SEVERITY.FAIL,
          code: issue.status,
          label: STATUS_LABEL[issue.status],
          message: issue.req.pset + '.' + issue.req.prop +
            (issue.detail ? ' — ' + issue.detail : ''),
          rule: target.target.agency + ' · ' + target.target.component,
        });
      }
    }

    // User presets. The gateway/authority scope does not apply to them: they
    // are not part of the mapping, so there is nothing to scope them by.
    const presetResults = [];
    let presetPass = 0;
    let presetFail = 0;
    for (const preset of (ctx.inputs && ctx.inputs.presets) || []) {
      const r = runPreset(ctx.index, preset);
      presetResults.push(r);
      for (const row of r.rows) {
        elementKeys.add(row.element.key);
        if (row.result === RESULT.PASS) {
          presetPass++;
          continue;
        }
        presetFail++;
        findings.push({
          element: row.element,
          severity: SEVERITY.FAIL,
          code: 'preset-' + row.result,
          label: RESULT_LABEL[row.result],
          message: preset.pset + '.' + preset.prop + (row.detail ? ' — ' + row.detail : ''),
          rule: 'Preset · ' + preset.name,
        });
      }
    }

    return {
      summary: {
        // Deduplicated. `raw.totals.elements` counts an element once per
        // component it belongs to, which double-counts anything the mapping
        // selects from more than one row — a wall is both "Household Shelter"
        // and every other IfcWall component.
        elements: elementKeys.size,
        assertions: raw.totals.checks + presetPass + presetFail,
        pass: raw.totals.pass + presetPass,
        fail: raw.totals.fail + presetFail,
        elementKeys: [...elementKeys],
      },
      findings,
      // The shell never reads this; it is handed straight back to render().
      detail: { ...raw, presets: presetResults },
    };
  },

  /**
   * One block per failing component, collapsing the per-element issues to a
   * line per requirement and status. Clicking a block colours its compliant and
   * non-compliant elements against each other.
   */
  render(result, host, actions) {
    const presetHost = document.createElement('div');
    const mappingHost = document.createElement('div');
    host.replaceChildren(presetHost, mappingHost);
    renderPresets(result.detail.presets || [], presetHost, actions);
    renderMapping(result, mappingHost, actions);
  },

  /**
   * Live pass/fail for one element, for the inspector. Evaluated on demand
   * rather than read from a stored result, so it is correct even when no check
   * has been run yet.
   */
  explain(element, ctx) {
    const findings = [];

    // Enabled presets first, read from the store because the inspector has no
    // check inputs to hand.
    for (const preset of enabledPresets()) {
      if (!matchesPreset(element, preset)) continue;
      const r = testElement(element, preset);
      findings.push({
        element,
        severity: r.result === RESULT.PASS ? SEVERITY.PASS : SEVERITY.FAIL,
        code: 'preset-' + r.result,
        label: RESULT_LABEL[r.result],
        message: preset.name,
        value: isEmptyValue(r.value) ? '—' : formatValue(r.value),
        colour: RESULT_COLOUR[r.result],
        rule: 'Value presets',
      });
    }

    const applicable = ctx.ruleset.targets.filter(
      (t) => matchesTarget(element, t) && t.requirements.length);

    for (const target of applicable) {
      for (const req of target.requirements) {
        const r = evaluate(element, req, ctx.ruleset);
        findings.push({
          element,
          severity: SEVERITY_OF[r.status] || SEVERITY.FAIL,
          code: r.status,
          label: STATUS_LABEL[r.status],
          message: req.pset + '.' + req.prop,
          value: isEmptyValue(r.value) ? '—' : formatValue(r.value),
          colour: STATUS_COLOUR[r.status],
          rule: target.agency + ' · ' + target.component,
        });
      }
    }
    return findings;
  },
};

/**
 * One block per preset that ran, with its pass/fail split. Clicking a block
 * colours the elements it selected, so the user can see the query picked the
 * right things.
 */
function renderPresets(results, host, actions) {
  if (!results.length) return;

  host.innerHTML = '<div class="cm-head" style="padding:8px 10px 4px">Value presets</div>' +
    results.map((r, i) => {
      const pass = r.byResult[RESULT.PASS].length;
      const fail = r.elements.length - pass;
      const pill = !r.elements.length
        ? '<span class="pill">no elements</span>'
        : fail ? `<span class="pill bad">${fail}</span>` : '<span class="pill ok">clean</span>';

      // The distinct offending values, which is usually what needs fixing.
      const bad = new Map();
      for (const row of r.rows) {
        if (row.result === RESULT.PASS) continue;
        const key = row.result === RESULT.MISSING ? RESULT_LABEL[RESULT.MISSING]
          : isEmptyValue(row.value) ? '(empty)' : formatValue(row.value);
        const entry = bad.get(key) || { result: row.result, n: 0 };
        entry.n++;
        bad.set(key, entry);
      }

      return `<div class="issue-target" data-i="${i}">
        <div class="issue-head">
          <span class="iname">${esc(r.preset.name)}
            <small>${esc(describePreset(r.preset))} · ${r.elements.length} elements</small>
          </span>${pill}
        </div>
        <div class="issue-body"><div class="ilist">${[...bad.entries()]
          .sort((a, b) => b[1].n - a[1].n)
          .map(([label, x]) => `
            <div class="irow">
              <span class="status-dot" style="background:${hex(RESULT_COLOUR[x.result])}"></span>
              <span class="ik">${esc(label)}</span>
              <span class="iv">${x.n}</span>
            </div>`).join('') || '<div class="irow"><span class="ik">Every selected element meets the preset.</span></div>'}
        </div></div>
      </div>`;
    }).join('');

  host.querySelectorAll('.issue-target').forEach((node) => {
    const r = results[+node.dataset.i];
    node.querySelector('.issue-head').addEventListener('click', () => {
      node.classList.toggle('open');
      if (!r.elements.length) {
        actions.toast(`No ${r.preset.entity} elements in the loaded model.`);
        return;
      }
      actions.showInModel(
        [RESULT.PASS, RESULT.FAIL, RESULT.MISSING].map((code) => ({
          label: RESULT_LABEL[code],
          colour: RESULT_COLOUR[code],
          elements: r.byResult[code],
        })),
        r.preset.name,
        'value preset · ' + r.elements.length + ' elements');
    });
  });
}

/**
 * One block per failing component, collapsing the per-element issues to a
 * line per requirement and status. Clicking a block colours its compliant and
 * non-compliant elements against each other.
 */
function renderMapping(result, host, actions) {
  const failing = result.detail.targets.filter((r) => r.fail > 0);

  if (!failing.length) {
    host.innerHTML = '<div class="empty-note">' + (
      result.detail.totals.checks
        ? 'Every mapped element satisfies its IFC-SG requirements in this scope.'
        : 'No mapped components found in this model for this scope.'
    ) + '</div>';
    return;
  }

  host.innerHTML = failing.map((r, ri) => {
    const byReq = new Map();
    for (const issue of r.issues) {
      const key = issue.req.pset + '.' + issue.req.prop + '|' + issue.status;
      if (!byReq.has(key)) byReq.set(key, { req: issue.req, status: issue.status, n: 0 });
      byReq.get(key).n++;
    }
    const rows = [...byReq.values()].sort((a, b) => b.n - a.n);

    return '<div class="issue-target" data-i="' + ri + '">' +
      '<div class="issue-head">' +
        '<span class="iname">' + esc(r.target.component) +
          '<small>' + esc(r.target.agency) + ' · ' + esc(r.target.entity) +
          ' · ' + r.elements.length + ' elements</small>' +
        '</span>' +
        '<span class="pill bad">' + r.fail + '</span>' +
      '</div>' +
      '<div class="issue-body"><div class="ilist">' +
        rows.map((x) =>
          '<div class="irow">' +
            '<span class="status-dot" style="background:' + hex(STATUS_COLOUR[x.status]) + '"></span>' +
            '<span class="ik">' + esc(x.req.prop) + '<br>' +
              '<span style="color:var(--text-dim);font-size:10.5px">' +
              esc(x.req.pset) + ' — ' + esc(STATUS_LABEL[x.status]) + '</span></span>' +
            '<span class="iv">' + x.n + '</span>' +
          '</div>').join('') +
      '</div></div>' +
    '</div>';
  }).join('');

  host.querySelectorAll('.issue-target').forEach((node) => {
    const r = failing[+node.dataset.i];
    node.querySelector('.issue-head').addEventListener('click', () => {
      node.classList.toggle('open');
      const bad = new Set(r.issues.map((i) => i.element.key));
      actions.showInModel([
        {
          label: r.target.component + ' — issues',
          colour: STATUS_COLOUR[STATUS.MISSING_PROP],
          elements: r.elements.filter((e) => bad.has(e.key)),
        },
        {
          label: r.target.component + ' — compliant',
          colour: STATUS_COLOUR[STATUS.PASS],
          elements: r.elements.filter((e) => !bad.has(e.key)),
        },
      ].filter((g) => g.elements.length),
      r.target.component,
      'check result · ' + r.elements.length + ' elements');
    });
  });
}

export default module;
