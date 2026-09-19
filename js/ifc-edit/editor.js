/**
 * Last-mile IFC editing: fix a property, add a missing one, move one to the
 * right property set, rename a storey — and write a file that differs from the
 * original only in those lines.
 *
 * Edits are patches over the file the browser still holds (see ifc-text.js).
 * Export streams the original bytes with the changed lines spliced in and the
 * new lines appended before the DATA section closes, so a 170 MB submission
 * file is never copied whole and untouched lines stay byte-identical.
 *
 * The one rule that makes this safe is **clone on shared**. Revit writes a
 * property value once and references it from every property set that carries
 * the same value, and it attaches one property set to many elements through
 * a single relationship. Changing such a line in place would silently change
 * every element that shares it. So before a property set or property is
 * written, it is cloned for the element being edited whenever anything else
 * still refers to it, and the shared original is left alone.
 *
 * This edits the IFC, not the Revit model. The next export from Revit will
 * not carry these changes; the durable fix belongs in the authoring model.
 */

import {
  scanFile, readLines, parseLine, serialiseLine, plainValue,
  NULL, ref, str, enumv, num, list, typed,
} from '../ifc-text.js';
import { ifcGuid } from './guid.js';

// IfcRelDefinesByProperties: GlobalId, OwnerHistory, Name, Description, RelatedObjects, RelatingPropertyDefinition
const REL_OBJECTS = 4, REL_PSET = 5;
// IfcPropertySet: GlobalId, OwnerHistory, Name, Description, HasProperties
const PSET_NAME = 2, PSET_PROPS = 4;
// IfcPropertySingleValue: Name, Description, NominalValue, Unit
const PROP_NAME = 0, PROP_VALUE = 2;
// IfcRoot: GlobalId, OwnerHistory, Name, Description
const ROOT_NAME = 2;

/** IFC value wrapper for a workbook data type when no existing value shows one. */
const WRAPPER_FOR_TYPE = {
  BOOLEAN: 'IFCBOOLEAN', LOGICAL: 'IFCLOGICAL', LABEL: 'IFCLABEL', TEXT: 'IFCTEXT',
  IDENTIFIER: 'IFCIDENTIFIER', INTEGER: 'IFCINTEGER', REAL: 'IFCREAL', NUMBER: 'IFCREAL',
  LENGTH: 'IFCLENGTHMEASURE', AREA: 'IFCAREAMEASURE', VOLUME: 'IFCVOLUMEMEASURE',
  COUNT: 'IFCCOUNTMEASURE', VOLUMETRICFLOWRATE: 'IFCVOLUMETRICFLOWRATEMEASURE',
  THERMALTRANSMITTANCE: 'IFCTHERMALTRANSMITTANCEMEASURE', POWER: 'IFCPOWERMEASURE',
  POSITIVELENGTH: 'IFCPOSITIVELENGTHMEASURE', PLANEANGLE: 'IFCPLANEANGLEMEASURE',
  RATIO: 'IFCRATIOMEASURE', PERCENT: 'IFCRATIOMEASURE', DATE: 'IFCLABEL',
};

const isBoolWrapper = (w) => w === 'IFCBOOLEAN' || w === 'IFCLOGICAL';
const isNumWrapper = (w) => /MEASURE$|^IFCREAL$|^IFCINTEGER$|^IFCNUMERICMEASURE$|^IFCCOUNTMEASURE$/.test(w);

/**
 * Builds the STEP value for a user-supplied value. The wrapper comes from the
 * property's existing value where there is one, so a length stays a length,
 * else from the requirement's declared type.
 */
export function toStepValue(input, { dataType = null, existing = null } = {}) {
  let wrapper = existing && existing.kind === 'typed' ? existing.name : null;
  if (!wrapper) wrapper = WRAPPER_FOR_TYPE[String(dataType || '').replace(/\s+/g, '').toUpperCase()] || 'IFCLABEL';

  const text = String(input == null ? '' : input).trim();
  if (isBoolWrapper(wrapper)) {
    const up = text.toUpperCase();
    const truthy = ['TRUE', 'T', 'YES', 'Y', '1'].includes(up);
    const falsy = ['FALSE', 'F', 'NO', 'N', '0'].includes(up);
    if (!truthy && !falsy) {
      if (wrapper === 'IFCLOGICAL' && ['U', 'UNKNOWN'].includes(up)) return typed(wrapper, enumv('U'));
      throw new Error(`"${text}" is not a boolean; use TRUE or FALSE.`);
    }
    return typed(wrapper, enumv(truthy ? 'T' : 'F'));
  }
  if (isNumWrapper(wrapper)) {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`"${text}" is not a number.`);
    if (wrapper === 'IFCINTEGER' || wrapper === 'IFCCOUNTMEASURE') return typed(wrapper, { kind: 'num', raw: String(Math.round(n)) });
    return typed(wrapper, num(n));
  }
  return typed(wrapper, str(text));
}

/** Case-insensitive name match, as the checks do. */
const same = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

export class IfcEditor {
  /**
   * @param {File} file        the IFC as loaded
   * @param {object} [options]
   * @param {string} [options.name]  display name for the log
   */
  constructor(file, { name = file.name, scan = null } = {}) {
    this.file = file;
    this.name = name;
    /** A scan made earlier (for GUID lookup, say) is reused rather than repeated. */
    this.scan = scan;
    this.ready = null;

    /** element id -> relationship ids attaching property sets to it */
    this.relsOf = new Map();
    /** relationship id -> property set id */
    this.relPset = new Map();
    /** property set id -> number of relationships pointing at it */
    this.psetRefs = new Map();
    /** property id -> number of property sets listing it */
    this.propRefs = new Map();

    /** id -> current StepLine for every line touched (edited or created) */
    this.lines = new Map();
    this.dirty = new Set();
    this.created = new Set();
    this.deleted = new Set();
    this.nextId = 0;
    this.eol = '\n';

    /** @type {Array<{at: string, op: string, element: object, pset?: string, prop?: string, from?: *, to?: *}>} */
    this.log = [];
  }

  /**
   * Scans the file and reads every property relationship once, so sharing can
   * be judged. Idempotent; the first edit calls it if nothing else has.
   */
  prepare(onProgress = () => {}) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.scan) this.scan = await scanFile(this.file, (pct) => onProgress('Reading file structure…', pct * 0.6));
      this.nextId = this.scan.maxId + 1;
      this.eol = this.scan.header.includes('\r\n') ? '\r\n' : '\n';

      const relIds = this.scan.idsByEntity.get('IFCRELDEFINESBYPROPERTIES') || [];
      const psetIds = this.scan.idsByEntity.get('IFCPROPERTYSET') || [];
      onProgress('Reading property relationships…', 65);
      const texts = await readLines(this.scan, [...relIds, ...psetIds]);
      onProgress('Indexing property sets…', 85);

      let n = 0;
      for (const id of relIds) {
        const line = this._parse(texts.get(id));
        if (!line) continue;
        const objects = line.attrs[REL_OBJECTS];
        const pset = line.attrs[REL_PSET];
        if (!objects || objects.kind !== 'list' || !pset || pset.kind !== 'ref') continue;
        for (const o of objects.items) {
          if (o.kind !== 'ref') continue;
          let l = this.relsOf.get(o.id);
          if (!l) this.relsOf.set(o.id, (l = []));
          l.push(id);
        }
        this.relPset.set(id, pset.id);
        this.psetRefs.set(pset.id, (this.psetRefs.get(pset.id) || 0) + 1);
        if (++n % 20000 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      for (const id of psetIds) {
        const line = this._parse(texts.get(id));
        const props = line && line.attrs[PSET_PROPS];
        if (!props || props.kind !== 'list') continue;
        for (const p of props.items) {
          if (p.kind === 'ref') this.propRefs.set(p.id, (this.propRefs.get(p.id) || 0) + 1);
        }
      }
      onProgress('Ready', 100);
    })();
    return this.ready;
  }

  _parse(text) {
    if (!text) return null;
    try {
      return parseLine(text);
    } catch (err) {
      console.warn('Unparseable IFC line skipped:', text.slice(0, 80), err);
      return null;
    }
  }

  get editCount() {
    return this.log.length;
  }

  get hasEdits() {
    return this.dirty.size + this.created.size + this.deleted.size > 0;
  }

  /** The current state of a line: edited, created, or straight from the file. */
  async getLine(id) {
    if (this.deleted.has(id)) return null;
    const cached = this.lines.get(id);
    if (cached) return cached;
    const texts = await readLines(this.scan, [id]);
    const line = this._parse(texts.get(id));
    if (line) this.lines.set(id, line);
    return line;
  }

  async _getLines(ids) {
    const missing = ids.filter((id) => !this.lines.has(id) && !this.deleted.has(id));
    if (missing.length) {
      const texts = await readLines(this.scan, missing);
      for (const id of missing) {
        const line = this._parse(texts.get(id));
        if (line) this.lines.set(id, line);
      }
    }
    return ids.map((id) => (this.deleted.has(id) ? null : this.lines.get(id) || null));
  }

  _touch(line) {
    this.lines.set(line.id, line);
    if (!this.created.has(line.id)) this.dirty.add(line.id);
  }

  _create(name, attrs) {
    const line = { id: this.nextId++, name, attrs };
    this.lines.set(line.id, line);
    this.created.add(line.id);
    return line;
  }

  _delete(id) {
    this.lines.delete(id);
    this.dirty.delete(id);
    if (this.created.has(id)) this.created.delete(id);
    else this.deleted.add(id);
  }

  // ---------------------------------------------------------------- reading

  /**
   * The occurrence property sets attached to an element, with their properties.
   * @returns {Promise<Array<{rel: object, pset: object, name: string,
   *   props: Array<{line: object, name: string, value: object}>}>>}
   */
  async elementPsets(elementId) {
    await this.prepare();
    const relIds = this.relsOf.get(elementId) || [];
    const rels = await this._getLines(relIds);
    const psetRef = (r) => (r && r.attrs[REL_PSET] && r.attrs[REL_PSET].kind === 'ref' ? r.attrs[REL_PSET].id : 0);
    const psets = await this._getLines(rels.map(psetRef));

    const out = [];
    const propIds = [];
    for (let i = 0; i < rels.length; i++) {
      const pset = psets[i];
      if (!rels[i] || !pset || pset.name !== 'IFCPROPERTYSET') continue;
      const list_ = pset.attrs[PSET_PROPS];
      if (!list_ || list_.kind !== 'list') continue;
      for (const p of list_.items) if (p.kind === 'ref') propIds.push(p.id);
      out.push({ rel: rels[i], pset, name: plainValue(pset.attrs[PSET_NAME]) || '', props: [] });
    }
    const propLines = await this._getLines(propIds);
    const byId = new Map(propIds.map((id, i) => [id, propLines[i]]));
    for (const entry of out) {
      const items = entry.pset.attrs[PSET_PROPS].items;
      for (const p of items) {
        const line = p.kind === 'ref' ? byId.get(p.id) : null;
        if (!line || line.name !== 'IFCPROPERTYSINGLEVALUE') continue;
        entry.props.push({ line, name: plainValue(line.attrs[PROP_NAME]) || '', value: line.attrs[PROP_VALUE] });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- writing

  /**
   * The element's own copy of a property set, cloning the relationship and
   * the set if either is shared with other elements.
   */
  async _ownPset(elementId, entry) {
    let { rel, pset } = entry;
    const objects = rel.attrs[REL_OBJECTS];

    if (objects.items.length > 1) {
      // Detach this element from the shared relationship and give it its own.
      objects.items = objects.items.filter((o) => !(o.kind === 'ref' && o.id === elementId));
      this._touch(rel);
      const own = this._create('IFCRELDEFINESBYPROPERTIES', [
        str(ifcGuid()), rel.attrs[1], NULL, NULL, list([ref(elementId)]), ref(pset.id),
      ]);
      this.relsOf.set(elementId, (this.relsOf.get(elementId) || []).filter((id) => id !== rel.id).concat(own.id));
      this.relPset.set(own.id, pset.id);
      this.psetRefs.set(pset.id, (this.psetRefs.get(pset.id) || 0) + 1);
      rel = own;
    }

    if ((this.psetRefs.get(pset.id) || 0) > 1) {
      // The set itself is attached elsewhere: copy it for this element.
      const clone = this._create('IFCPROPERTYSET', [
        str(ifcGuid()), pset.attrs[1], pset.attrs[PSET_NAME], pset.attrs[3],
        list([...(pset.attrs[PSET_PROPS].items || [])]),
      ]);
      for (const p of clone.attrs[PSET_PROPS].items) {
        if (p.kind === 'ref') this.propRefs.set(p.id, (this.propRefs.get(p.id) || 0) + 1);
      }
      this.psetRefs.set(pset.id, this.psetRefs.get(pset.id) - 1);
      this.psetRefs.set(clone.id, 1);
      rel.attrs[REL_PSET] = ref(clone.id);
      this._touch(rel);
      this.relPset.set(rel.id, clone.id);
      pset = clone;
    }
    return { rel, pset };
  }

  /**
   * Sets one property on one element, creating the property set if the
   * element has none of that name.
   * @param {{expressID: number, globalId?: string, name?: string, entity?: string}} element
   * @param {string} psetName
   * @param {string} propName
   * @param {*} value     as typed by the user
   * @param {{dataType?: string}} [opts]  the requirement's declared type, for a new property
   */
  async setProperty(element, psetName, propName, value, { dataType = null } = {}) {
    await this.prepare();
    const elementId = element.expressID;
    const psets = await this.elementPsets(elementId);
    const found = psets.find((p) => same(p.name, psetName));
    const owner = found ? found.rel.attrs[1] : (await this._anyOwnerHistory(psets));

    if (!found) {
      const stepValue = toStepValue(value, { dataType });
      const prop = this._create('IFCPROPERTYSINGLEVALUE', [str(propName), NULL, stepValue, NULL]);
      const pset = this._create('IFCPROPERTYSET', [str(ifcGuid()), owner, str(psetName), NULL, list([ref(prop.id)])]);
      const rel = this._create('IFCRELDEFINESBYPROPERTIES', [str(ifcGuid()), owner, NULL, NULL, list([ref(elementId)]), ref(pset.id)]);
      this.relsOf.set(elementId, (this.relsOf.get(elementId) || []).concat(rel.id));
      this.relPset.set(rel.id, pset.id);
      this.psetRefs.set(pset.id, 1);
      this.propRefs.set(prop.id, 1);
      this._log('add', element, { pset: psetName, prop: propName, from: null, to: plainValue(stepValue) });
      return plainValue(stepValue);
    }

    const { pset } = await this._ownPset(elementId, found);
    const existing = found.props.find((p) => same(p.name, propName));
    const stepValue = toStepValue(value, { dataType, existing: existing ? existing.value : null });

    if (!existing) {
      const prop = this._create('IFCPROPERTYSINGLEVALUE', [str(propName), NULL, stepValue, NULL]);
      pset.attrs[PSET_PROPS].items.push(ref(prop.id));
      this._touch(pset);
      this.propRefs.set(prop.id, 1);
      this._log('add', element, { pset: psetName, prop: propName, from: null, to: plainValue(stepValue) });
      return plainValue(stepValue);
    }

    const before = plainValue(existing.value);
    if ((this.propRefs.get(existing.line.id) || 0) > 1) {
      // The value line is shared with other property sets: clone it.
      const prop = this._create('IFCPROPERTYSINGLEVALUE', [existing.line.attrs[0], existing.line.attrs[1], stepValue, existing.line.attrs[3]]);
      const items = pset.attrs[PSET_PROPS].items;
      const at = items.findIndex((p) => p.kind === 'ref' && p.id === existing.line.id);
      items[at] = ref(prop.id);
      this._touch(pset);
      this.propRefs.set(existing.line.id, this.propRefs.get(existing.line.id) - 1);
      this.propRefs.set(prop.id, 1);
    } else {
      existing.line.attrs[PROP_VALUE] = stepValue;
      this._touch(existing.line);
    }
    this._log('set', element, { pset: psetName, prop: propName, from: before, to: plainValue(stepValue) });
    return plainValue(stepValue);
  }

  /** Removes one property from one element's set; an emptied set goes too. */
  async removeProperty(element, psetName, propName) {
    await this.prepare();
    const elementId = element.expressID;
    const found = (await this.elementPsets(elementId)).find((p) => same(p.name, psetName));
    if (!found) return false;
    const existing = found.props.find((p) => same(p.name, propName));
    if (!existing) return false;

    const { rel, pset } = await this._ownPset(elementId, found);
    const items = pset.attrs[PSET_PROPS].items;
    pset.attrs[PSET_PROPS].items = items.filter((p) => !(p.kind === 'ref' && p.id === existing.line.id));
    const refs = (this.propRefs.get(existing.line.id) || 1) - 1;
    this.propRefs.set(existing.line.id, refs);
    if (refs === 0) this._delete(existing.line.id);

    if (pset.attrs[PSET_PROPS].items.length === 0) {
      // A property set must list at least one property; drop it and its relationship.
      this._delete(pset.id);
      this._delete(rel.id);
      this.relsOf.set(elementId, (this.relsOf.get(elementId) || []).filter((id) => id !== rel.id));
      this.psetRefs.delete(pset.id);
    } else {
      this._touch(pset);
    }
    this._log('remove', element, { pset: psetName, prop: propName, from: plainValue(existing.value), to: null });
    return true;
  }

  /** Moves a property, keeping its value and wrapper, from one set to another. */
  async moveProperty(element, fromPset, propName, toPset, { dataType = null } = {}) {
    await this.prepare();
    const found = (await this.elementPsets(element.expressID)).find((p) => same(p.name, fromPset));
    const existing = found && found.props.find((p) => same(p.name, propName));
    if (!existing) throw new Error(`${fromPset}.${propName} is not on this element.`);
    const value = plainValue(existing.value);
    const wrapper = existing.value.kind === 'typed' ? existing.value.name : null;
    await this._setWithWrapper(element, toPset, propName, value, wrapper, dataType);
    await this.removeProperty(element, fromPset, propName);
    // The two entries above read as one move.
    this.log.splice(-2, 2, this._entry('move', element, { pset: `${fromPset} → ${toPset}`, prop: propName, from: value, to: value }));
    return true;
  }

  async _setWithWrapper(element, psetName, propName, value, wrapper, dataType) {
    // Same as setProperty, but a known wrapper wins over the declared type.
    const type = wrapper ? Object.keys(WRAPPER_FOR_TYPE).find((k) => WRAPPER_FOR_TYPE[k] === wrapper) : null;
    if (typeof value === 'boolean') value = value ? 'TRUE' : 'FALSE';
    return this.setProperty(element, psetName, propName, value, { dataType: type || dataType });
  }

  /** Renames any IfcRoot entity, a storey most usefully. */
  async setName(element, name) {
    await this.prepare();
    const line = await this.getLine(element.expressID);
    if (!line) throw new Error(`Line #${element.expressID} is not in the file.`);
    const before = plainValue(line.attrs[ROOT_NAME]);
    line.attrs[ROOT_NAME] = str(name);
    this._touch(line);
    this._log('rename', element, { from: before, to: name });
    return name;
  }

  async _anyOwnerHistory(psets) {
    if (psets.length) return psets[0].rel.attrs[1];
    // Borrow from any relationship in the file; a file with none gets $.
    const relIds = this.scan.idsByEntity.get('IFCRELDEFINESBYPROPERTIES') || [];
    if (!relIds.length) return NULL;
    const [rel] = await this._getLines([relIds[0]]);
    return rel ? rel.attrs[1] : NULL;
  }

  _entry(op, element, fields) {
    return {
      at: new Date().toISOString(),
      op,
      element: {
        expressID: element.expressID, globalId: element.globalId || null,
        name: element.name || null, entity: element.entity || null,
      },
      ...fields,
    };
  }

  _log(op, element, fields) {
    this.log.push(this._entry(op, element, fields));
  }

  /** Forgets every edit. */
  discard() {
    this.lines.clear();
    this.dirty.clear();
    this.created.clear();
    this.deleted.clear();
    this.log = [];
    this.nextId = this.scan ? this.scan.maxId + 1 : 0;
  }

  // ---------------------------------------------------------------- export

  /** The lines this export will change or add, serialised. */
  changedLines() {
    const out = [];
    for (const id of this.dirty) out.push({ id, text: serialiseLine(this.lines.get(id)) });
    for (const id of this.created) out.push({ id, text: serialiseLine(this.lines.get(id)) });
    for (const id of this.deleted) out.push({ id, text: null });
    return out;
  }

  /**
   * The edited file. Original bytes are sliced around the changed lines, so
   * memory is a few parts, not a second copy of the file.
   * @returns {Blob}
   */
  export() {
    const scan = this.scan;
    const file = this.file;
    const enc = new TextEncoder();
    const parts = [];

    const changes = [...this.dirty].map((id) => ({ id, text: serialiseLine(this.lines.get(id)) }))
      .concat([...this.deleted].map((id) => ({ id, text: null })))
      .filter((c) => scan.ends[c.id])
      .sort((a, b) => scan.starts[a.id] - scan.starts[b.id]);

    let cursor = 0;
    for (const c of changes) {
      const start = scan.starts[c.id];
      let end = scan.ends[c.id];
      // Take the line terminator with a deleted line so no blank line is left.
      if (c.text === null) end = Math.min(file.size, end + this.eol.length);
      if (start > cursor) parts.push(file.slice(cursor, start));
      if (c.text !== null) parts.push(enc.encode(c.text));
      cursor = end;
    }

    if (this.created.size) {
      const at = scan.dataEnd;
      if (at > cursor) parts.push(file.slice(cursor, at));
      const lines = [...this.created].sort((a, b) => a - b).map((id) => serialiseLine(this.lines.get(id)));
      parts.push(enc.encode(lines.join(this.eol) + this.eol));
      cursor = at;
    }
    if (cursor < file.size) parts.push(file.slice(cursor));
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  /** `name-edited.ifc` */
  get exportName() {
    return this.name.replace(/\.ifc$/i, '') + '-edited.ifc';
  }

  /**
   * Re-parses the changed lines with web-ifc, on a small file made of just
   * them, so a syntax slip is caught before the download and without holding
   * the whole model in wasm memory a second time.
   * @param {object} WebIFC   the web-ifc module
   * @param {string} wasmPath
   * @returns {Promise<{ok: boolean, problems: string[]}>}
   */
  async validate(WebIFC, wasmPath) {
    const changed = this.changedLines().filter((c) => c.text !== null);
    if (!changed.length) return { ok: true, problems: [] };
    const problems = [];
    const header = this.scan.header.replace(/\r?\n/g, '\n');
    const text = header + (header.trim().endsWith('ENDSEC;') ? '' : 'ENDSEC;\n') +
      'DATA;\n' + changed.map((c) => c.text).join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(wasmPath);
    await api.Init();
    let modelID = -1;
    try {
      modelID = api.OpenModel(new TextEncoder().encode(text));
      for (const c of changed) {
        let line = null;
        try { line = api.GetLine(modelID, c.id, false); } catch { line = null; }
        const expected = this.lines.get(c.id).name;
        if (!line) problems.push(`#${c.id} (${expected}) did not parse.`);
        else if (WebIFC[expected] !== undefined && line.type !== WebIFC[expected]) {
          problems.push(`#${c.id} read back as a different entity type.`);
        }
      }
    } catch (err) {
      problems.push('web-ifc could not open the edited lines: ' + (err && err.message ? err.message : err));
    } finally {
      try { if (modelID >= 0) api.CloseModel(modelID); } catch { /* nothing to close */ }
    }
    return { ok: problems.length === 0, problems };
  }
}
