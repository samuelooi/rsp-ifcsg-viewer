/**
 * Shared machinery for authority rule checks (URA, BCA, and whatever follows).
 *
 * An authority check is a list of published rules evaluated against the model.
 * The rules differ; the plumbing — iterating, counting, collecting findings,
 * rendering them, colouring them — does not. So a module built with this kit
 * declares its rules as *data* and writes no loop of its own. Adding a rule
 * later is an edit to an array, not to control flow.
 *
 * A rule is evaluated one of two ways:
 *
 *  - **Per element** — `select` returns the elements it applies to and `assert`
 *    is called once per element. This covers almost everything: a clearance, a
 *    required property value, a minimum dimension.
 *  - **Whole model** — `evaluate` is called once and returns findings itself.
 *    This is the escape hatch for rules about totals rather than elements, like
 *    a plot ratio or a provision count against a quantity.
 *
 * Both are optional per rule; a rule declares whichever fits.
 */

import { SEVERITY, SEVERITY_COLOUR, SEVERITY_LABEL } from './severity.js';
import { esc, hex } from '../util/dom.js';

/**
 * @typedef {object} AuthorityRule
 * @property {string} id           Stable slug, e.g. 'ura-gfa-declared'.
 * @property {string} title        What the rule requires, in one line.
 * @property {string} [reference]  Where it comes from — clause, handbook, circular.
 * @property {string} [severity]   Severity when it fails. Defaults to FAIL.
 * @property {(ctx) => boolean} [applies]
 *           Whether the rule is in scope at all. A rule needing a site boundary
 *           the model does not have is *skipped*, which is not the same as passing.
 * @property {(ctx) => object[]} [select]   Elements to test.
 * @property {(el, ctx) => true|string} [assert]
 *           true when the element satisfies the rule, otherwise the reason why not.
 * @property {(ctx) => object[]} [evaluate]
 *           Whole-model alternative, returning findings directly.
 */

/**
 * Builds a CheckModule from a list of rules.
 * @param {{ authority: string, rules: AuthorityRule[], note?: string }} config
 * @returns {import('./types.js').CheckModule}
 */
export function createAuthorityCheck(config) {
  const { authority, rules, note, inScope } = config;

  return {
    run(ctx) {
      const findings = [];
      const elementKeys = new Set();
      const perRule = [];
      let assertions = 0;
      let pass = 0;
      let fail = 0;

      // A rule outside the declared scope — the wrong submission gateway, say —
      // is not evaluated *and not reported*. That differs from a skipped rule,
      // which the model could have answered but did not: an out-of-scope rule
      // was never asked, so listing it would only pad the report.
      const active = inScope ? rules.filter((rule) => inScope(rule, ctx)) : rules;
      const outOfScope = rules.length - active.length;

      for (const rule of active) {
        if (ctx.signal && ctx.signal.aborted) break;

        const severity = rule.severity || SEVERITY.FAIL;
        // `elements` is kept so the results view can colour the rule's passing
        // elements without re-running `select` outside a check context.
        const stat = {
          rule, tested: 0, passed: 0, failed: 0, skipped: false,
          findings: [], elements: [],
        };

        // A rule that cannot be evaluated is reported as skipped rather than
        // silently passing — an unanswerable rule is not a satisfied one.
        if (rule.applies && !rule.applies(ctx)) {
          stat.skipped = true;
          perRule.push(stat);
          continue;
        }

        if (typeof rule.evaluate === 'function') {
          const produced = rule.evaluate(ctx) || [];
          for (const f of produced) {
            const finding = {
              severity,
              code: rule.id,
              label: rule.title,
              rule: authority + ' · ' + rule.title,
              ...f,
            };
            stat.findings.push(finding);
            findings.push(finding);
            if (finding.element) elementKeys.add(finding.element.key);
            assertions++;
            if (finding.severity === SEVERITY.PASS) { pass++; stat.passed++; }
            else { fail++; stat.failed++; }
            stat.tested++;
          }
          perRule.push(stat);
          continue;
        }

        const elements = (rule.select ? rule.select(ctx) : []) || [];
        stat.elements = elements;
        for (const el of elements) {
          elementKeys.add(el.key);
          assertions++;
          stat.tested++;

          const verdict = rule.assert ? rule.assert(el, ctx) : true;
          if (verdict === true) {
            pass++;
            stat.passed++;
            continue;
          }

          fail++;
          stat.failed++;
          const finding = {
            element: el,
            severity,
            code: rule.id,
            label: rule.title,
            message: typeof verdict === 'string' ? verdict : 'Does not satisfy this rule.',
            rule: authority + ' · ' + rule.title,
          };
          stat.findings.push(finding);
          findings.push(finding);
        }
        perRule.push(stat);
      }

      return {
        summary: {
          elements: elementKeys.size,
          assertions,
          pass,
          fail,
          elementKeys: [...elementKeys],
        },
        findings,
        note: rules.length ? (typeof note === 'function' ? note(ctx) : note) : undefined,
        detail: { authority, perRule, empty: rules.length === 0, outOfScope },
      };
    },

    render(result, host, actions) {
      const { perRule, empty } = result.detail;

      if (empty) {
        host.innerHTML =
          '<div class="empty-note">No ' + esc(authority) + ' rules are defined yet. ' +
          'The check is wired up and will run as soon as its rules are added to ' +
          '<code>js/checks/' + esc(authority.toLowerCase()) + '/rules.js</code>.</div>';
        return;
      }

      const evaluated = perRule.filter((s) => !s.skipped);
      const skipped = perRule.filter((s) => s.skipped);

      const blocks = evaluated
        .slice()
        .sort((a, b) => b.failed - a.failed || b.tested - a.tested)
        .map((stat, i) => {
          const clean = stat.failed === 0;
          // A rule that selected nothing has not found the model clean — it
          // found nothing to look at. Saying "pass" there is how a check quietly
          // reassures you about something it never examined.
          const empty = stat.tested === 0;
          const pill = empty
            ? '<span class="pill">none</span>'
            : clean
              ? '<span class="pill ok">' + stat.tested + '</span>'
              : '<span class="pill bad">' + stat.failed + '</span>';

          const rows = stat.findings.slice(0, 200).map((f) =>
            '<div class="irow">' +
              '<span class="status-dot" style="background:' +
                hex(SEVERITY_COLOUR[f.severity] || SEVERITY_COLOUR[SEVERITY.FAIL]) + '"></span>' +
              '<span class="ik">' + esc(f.element ? (f.element.name || f.element.entity) : authority) +
                '<br><span style="color:var(--text-dim);font-size:10.5px">' +
                esc(f.message || SEVERITY_LABEL[f.severity]) + '</span></span>' +
            '</div>').join('');

          const more = stat.findings.length > 200
            ? '<div class="irow"><span class="ik" style="color:var(--text-dim)">' +
              'and ' + (stat.findings.length - 200) + ' more…</span></div>'
            : '';

          return '<div class="issue-target" data-i="' + i + '">' +
            '<div class="issue-head">' +
              '<span class="iname">' + esc(stat.rule.title) +
                '<small>' + esc(stat.rule.reference || authority) +
                ' · ' + stat.tested + ' tested</small>' +
              '</span>' + pill +
            '</div>' +
            '<div class="issue-body"><div class="ilist">' +
              (rows || '<div class="irow"><span class="ik" style="color:var(--text-dim)">' +
                (empty
                  ? 'Nothing in the model falls within this rule\'s scope, so it was not tested.'
                  : 'Every tested element satisfies this rule.') +
                '</span></div>') + more +
            '</div></div>' +
          '</div>';
        }).join('');

      const skippedBlock = skipped.length
        ? '<div class="empty-note" style="margin-top:8px">' +
          '<b>' + skipped.length + ' rule' + (skipped.length > 1 ? 's' : '') + ' not evaluated</b> — ' +
          'the model does not carry what they need, so they are neither passed nor failed.<ul>' +
          skipped.map((s) => '<li>' + esc(s.rule.title) + '</li>').join('') +
          '</ul></div>'
        : '';

      const scopeBlock = result.detail.outOfScope
        ? '<div class="empty-note" style="margin-top:8px">' +
          result.detail.outOfScope + ' further rule' + (result.detail.outOfScope > 1 ? 's' : '') +
          ' apply to the other submission gateway and were not run.</div>'
        : '';

      host.innerHTML = blocks + skippedBlock + scopeBlock;

      const ordered = evaluated.slice().sort((a, b) => b.failed - a.failed || b.tested - a.tested);
      host.querySelectorAll('.issue-target').forEach((node) => {
        const stat = ordered[+node.dataset.i];
        node.querySelector('.issue-head').addEventListener('click', () => {
          node.classList.toggle('open');
          const flagged = new Set(stat.findings.map((f) => f.element && f.element.key).filter(Boolean));
          const all = stat.elements;
          const groups = [{
            label: stat.rule.title + ' — issues',
            colour: SEVERITY_COLOUR[stat.rule.severity || SEVERITY.FAIL],
            elements: stat.findings.map((f) => f.element).filter(Boolean),
          }];
          const passing = all.filter((e) => !flagged.has(e.key));
          if (passing.length) {
            groups.push({
              label: stat.rule.title + ' — compliant',
              colour: SEVERITY_COLOUR[SEVERITY.PASS],
              elements: passing,
            });
          }
          actions.showInModel(
            groups.filter((g) => g.elements.length),
            stat.rule.title,
            authority + ' · ' + stat.tested + ' tested');
        });
      });
    },
  };
}
