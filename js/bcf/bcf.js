/**
 * BCF 2.1: the issues format the CORENET X Model Checker returns and that
 * Revit and BCF viewers open. A bcfzip holds one folder per topic with the
 * markup (title, status, comments), optional viewpoints (camera, selected
 * components) and snapshots.
 *
 * Reading keeps the original XML document of every topic, so a field the
 * panel does not know about is written back exactly as it came. Writing edits
 * that document in place and builds fresh ones only for topics created here.
 * Zip entries that are not part of a topic (bcf.version, project.bcfp,
 * extensions) are carried through as bytes.
 */

import { readZip, writeZip } from './zip.js';
import { uuid } from '../ifc-edit/guid.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/**
 * @typedef {object} BcfComment
 * @property {string} guid
 * @property {string} date       ISO 8601
 * @property {string} author
 * @property {string} text
 * @property {string|null} viewpointGuid
 */

/**
 * @typedef {object} BcfViewpoint
 * @property {string} guid
 * @property {string} file           entry name inside the topic folder
 * @property {string|null} snapshot  entry name of the PNG, if any
 * @property {Uint8Array|null} snapshotData
 * @property {string[]} selection    IfcGuids of the selected components
 * @property {object|null} camera    { type: 'perspective'|'orthogonal', position, direction, up, fov?, scale? }
 * @property {Document|null} doc     the original viewpoint XML, when read from a file
 */

/**
 * @typedef {object} BcfTopic
 * @property {string} guid
 * @property {string} title
 * @property {string} type       TopicType, e.g. "Fail", "Alert", "Issue"
 * @property {string} status     TopicStatus, e.g. "Active", "Resolved"
 * @property {string} description
 * @property {string} author     CreationAuthor
 * @property {string} created    CreationDate
 * @property {string|null} modified
 * @property {string|null} modifiedBy
 * @property {string|null} assignedTo
 * @property {string|null} priority
 * @property {number|null} index
 * @property {BcfComment[]} comments
 * @property {BcfViewpoint[]} viewpoints
 * @property {Document|null} doc   original markup XML, when read from a file
 * @property {Map<string, Uint8Array>} extra  other files in the topic folder
 */

/**
 * @typedef {object} BcfFile
 * @property {BcfTopic[]} topics
 * @property {Map<string, Uint8Array>} extra  entries outside any topic folder
 * @property {string} version
 */

// ------------------------------------------------------------------ reading

const text = (el, tag) => {
  const n = el && el.getElementsByTagName(tag)[0];
  return n ? n.textContent : null;
};

function parseXml(bytes) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Malformed XML in BCF.');
  return doc;
}

function parseCamera(vi) {
  const read = (el) => el ? {
    x: Number(text(el, 'X')), y: Number(text(el, 'Y')), z: Number(text(el, 'Z')),
  } : null;
  const persp = vi.getElementsByTagName('PerspectiveCamera')[0];
  const ortho = vi.getElementsByTagName('OrthogonalCamera')[0];
  const cam = persp || ortho;
  if (!cam) return null;
  return {
    type: persp ? 'perspective' : 'orthogonal',
    position: read(cam.getElementsByTagName('CameraViewPoint')[0]),
    direction: read(cam.getElementsByTagName('CameraDirection')[0]),
    up: read(cam.getElementsByTagName('CameraUpVector')[0]),
    fov: persp ? Number(text(cam, 'FieldOfView')) : null,
    scale: ortho ? Number(text(cam, 'ViewToWorldScale')) : null,
  };
}

/**
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<BcfFile>}
 */
export async function readBcf(bytes) {
  const entries = await readZip(bytes);
  const byName = new Map(entries.map((e) => [e.name.replace(/\\/g, '/'), e.data]));
  const extra = new Map();
  const folders = new Map(); // topic folder -> Map(file -> bytes)

  for (const [name, data] of byName) {
    const slash = name.indexOf('/');
    if (slash < 0) { extra.set(name, data); continue; }
    const folder = name.slice(0, slash);
    if (!folders.has(folder)) folders.set(folder, new Map());
    folders.get(folder).set(name.slice(slash + 1), data);
  }

  let version = '2.1';
  if (extra.has('bcf.version')) {
    const v = /VersionId="([^"]+)"/.exec(new TextDecoder().decode(extra.get('bcf.version')));
    if (v) version = v[1];
  }

  const topics = [];
  for (const [folder, files] of folders) {
    const markup = files.get('markup.bcf');
    if (!markup) continue;
    const doc = parseXml(markup);
    const t = doc.getElementsByTagName('Topic')[0];
    if (!t) continue;

    const comments = [...doc.getElementsByTagName('Comment')].map((c) => {
      const vp = c.getElementsByTagName('Viewpoint')[0];
      return {
        guid: c.getAttribute('Guid') || uuid(),
        date: text(c, 'Date') || '',
        author: text(c, 'Author') || '',
        text: text(c, 'Comment') || '',
        viewpointGuid: vp ? vp.getAttribute('Guid') : null,
      };
    });

    const viewpoints = [];
    const used = new Set(['markup.bcf']);
    for (const v of doc.getElementsByTagName('Viewpoints')) {
      const file = text(v, 'Viewpoint') || 'viewpoint.bcfv';
      const snapshot = text(v, 'Snapshot');
      used.add(file);
      if (snapshot) used.add(snapshot);
      let vdoc = null, selection = [], camera = null;
      if (files.has(file)) {
        try {
          vdoc = parseXml(files.get(file));
          selection = [...vdoc.getElementsByTagName('Selection')]
            .flatMap((s) => [...s.getElementsByTagName('Component')])
            .map((c) => c.getAttribute('IfcGuid')).filter(Boolean);
          camera = parseCamera(vdoc);
        } catch { vdoc = null; }
      }
      viewpoints.push({
        guid: v.getAttribute('Guid') || uuid(),
        file, snapshot: snapshot || null,
        snapshotData: snapshot && files.has(snapshot) ? files.get(snapshot) : null,
        selection, camera, doc: vdoc,
      });
    }

    const topicExtra = new Map();
    for (const [f, d] of files) if (!used.has(f)) topicExtra.set(f, d);

    const idx = text(t, 'Index');
    topics.push({
      guid: t.getAttribute('Guid') || folder,
      title: text(t, 'Title') || '(untitled)',
      type: t.getAttribute('TopicType') || '',
      status: t.getAttribute('TopicStatus') || '',
      description: text(t, 'Description') || '',
      author: text(t, 'CreationAuthor') || '',
      created: text(t, 'CreationDate') || '',
      modified: text(t, 'ModifiedDate'),
      modifiedBy: text(t, 'ModifiedAuthor'),
      assignedTo: text(t, 'AssignedTo'),
      priority: text(t, 'Priority'),
      index: idx === null || idx === '' ? null : Number(idx),
      comments, viewpoints, doc, extra: topicExtra,
    });
  }

  topics.sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || a.created.localeCompare(b.created));
  return { topics, extra, version };
}

// ------------------------------------------------------------------ writing

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Writes markup for a topic created in the viewer, in schema order. */
function markupXml(topic) {
  const t = topic;
  const opt = (tag, v) => (v == null || v === '' ? '' : `    <${tag}>${esc(v)}</${tag}>\n`);
  return XML_HEAD +
    `<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n` +
    (t.files && t.files.length ? `  <Header>\n${t.files.map((f) =>
      `    <File isExternal="true"><Filename>${esc(f)}</Filename></File>\n`).join('')}  </Header>\n` : '') +
    `  <Topic Guid="${esc(t.guid)}"${t.type ? ` TopicType="${esc(t.type)}"` : ''}${t.status ? ` TopicStatus="${esc(t.status)}"` : ''}>\n` +
    `    <Title>${esc(t.title)}</Title>\n` +
    opt('Priority', t.priority) +
    (t.index == null ? '' : `    <Index>${t.index}</Index>\n`) +
    `    <CreationDate>${esc(t.created)}</CreationDate>\n` +
    `    <CreationAuthor>${esc(t.author)}</CreationAuthor>\n` +
    opt('ModifiedDate', t.modified) + opt('ModifiedAuthor', t.modifiedBy) +
    opt('AssignedTo', t.assignedTo) + opt('Description', t.description) +
    `  </Topic>\n` +
    t.comments.map((c) =>
      `  <Comment Guid="${esc(c.guid)}">\n    <Date>${esc(c.date)}</Date>\n    <Author>${esc(c.author)}</Author>\n` +
      `    <Comment>${esc(c.text)}</Comment>\n${c.viewpointGuid ? `    <Viewpoint Guid="${esc(c.viewpointGuid)}" />\n` : ''}  </Comment>\n`).join('') +
    t.viewpoints.map((v) =>
      `  <Viewpoints Guid="${esc(v.guid)}">\n    <Viewpoint>${esc(v.file)}</Viewpoint>\n` +
      `${v.snapshot ? `    <Snapshot>${esc(v.snapshot)}</Snapshot>\n` : ''}  </Viewpoints>\n`).join('') +
    `</Markup>\n`;
}

function viewpointXml(v) {
  const xyz = (p) => `<X>${p.x}</X><Y>${p.y}</Y><Z>${p.z}</Z>`;
  const cam = v.camera;
  return XML_HEAD +
    `<VisualizationInfo Guid="${esc(v.guid)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n` +
    `  <Components>\n` +
    (v.selection.length ? `    <Selection>\n${v.selection.map((g) => `      <Component IfcGuid="${esc(g)}" />\n`).join('')}    </Selection>\n` : '') +
    `    <Visibility DefaultVisibility="true" />\n` +
    `  </Components>\n` +
    (cam && cam.type === 'perspective' ?
      `  <PerspectiveCamera>\n    <CameraViewPoint>${xyz(cam.position)}</CameraViewPoint>\n` +
      `    <CameraDirection>${xyz(cam.direction)}</CameraDirection>\n    <CameraUpVector>${xyz(cam.up)}</CameraUpVector>\n` +
      `    <FieldOfView>${cam.fov || 60}</FieldOfView>\n  </PerspectiveCamera>\n` : '') +
    (cam && cam.type === 'orthogonal' ?
      `  <OrthogonalCamera>\n    <CameraViewPoint>${xyz(cam.position)}</CameraViewPoint>\n` +
      `    <CameraDirection>${xyz(cam.direction)}</CameraDirection>\n    <CameraUpVector>${xyz(cam.up)}</CameraUpVector>\n` +
      `    <ViewToWorldScale>${cam.scale || 1}</ViewToWorldScale>\n  </OrthogonalCamera>\n` : '') +
    `</VisualizationInfo>\n`;
}

/**
 * Updates the fields the panel edits inside a topic's original markup
 * document, leaving everything else untouched, and appends new comments.
 */
function updateMarkupDoc(topic) {
  const doc = topic.doc;
  const t = doc.getElementsByTagName('Topic')[0];
  t.setAttribute('TopicStatus', topic.status || '');
  if (topic.type) t.setAttribute('TopicType', topic.type);
  const setText = (parent, tag, value, after) => {
    let n = parent.getElementsByTagName(tag)[0];
    if (value == null || value === '') { if (n) n.remove(); return; }
    if (!n) {
      n = doc.createElement(tag);
      const ref = after ? parent.getElementsByTagName(after)[0] : null;
      if (ref && ref.nextSibling) parent.insertBefore(n, ref.nextSibling);
      else parent.appendChild(n);
    }
    n.textContent = value;
  };
  setText(t, 'Title', topic.title);
  setText(t, 'AssignedTo', topic.assignedTo, 'DueDate');
  setText(t, 'Description', topic.description);
  setText(t, 'ModifiedDate', topic.modified, 'CreationAuthor');
  setText(t, 'ModifiedAuthor', topic.modifiedBy, 'ModifiedDate');

  const existing = new Set([...doc.getElementsByTagName('Comment')].map((c) => c.getAttribute('Guid')));
  const root = doc.documentElement;
  for (const c of topic.comments) {
    if (existing.has(c.guid)) continue;
    const el = doc.createElement('Comment');
    el.setAttribute('Guid', c.guid);
    for (const [tag, v] of [['Date', c.date], ['Author', c.author], ['Comment', c.text]]) {
      const n = doc.createElement(tag); n.textContent = v; el.appendChild(n);
    }
    if (c.viewpointGuid) { const n = doc.createElement('Viewpoint'); n.setAttribute('Guid', c.viewpointGuid); el.appendChild(n); }
    // Comments precede Viewpoints in the schema.
    const firstVp = doc.getElementsByTagName('Viewpoints')[0];
    if (firstVp) root.insertBefore(el, firstVp); else root.appendChild(el);
  }
  return XML_HEAD + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, '') + '\n';
}

/**
 * @param {BcfFile} bcf
 * @returns {Promise<Blob>}
 */
export async function writeBcf(bcf) {
  const entries = [];
  const enc = new TextEncoder();
  const extra = new Map(bcf.extra || []);
  if (!extra.has('bcf.version')) {
    extra.set('bcf.version', enc.encode(XML_HEAD +
      '<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
      '  <DetailedVersion>2.1</DetailedVersion>\n</Version>\n'));
  }
  for (const [name, data] of extra) entries.push({ name, data });

  for (const topic of bcf.topics) {
    const folder = topic.guid + '/';
    entries.push({ name: folder + 'markup.bcf', data: enc.encode(topic.doc ? updateMarkupDoc(topic) : markupXml(topic)) });
    for (const v of topic.viewpoints) {
      const xml = v.doc ? XML_HEAD + new XMLSerializer().serializeToString(v.doc).replace(/^<\?xml[^>]*\?>\s*/, '') + '\n' : viewpointXml(v);
      entries.push({ name: folder + v.file, data: enc.encode(xml) });
      if (v.snapshot && v.snapshotData) entries.push({ name: folder + v.snapshot, data: v.snapshotData });
    }
    for (const [f, d] of topic.extra || []) entries.push({ name: folder + f, data: d });
  }
  return writeZip(entries);
}

// ----------------------------------------------------------------- creation

/** A new topic authored in the viewer. */
export function newTopic({ title, description = '', type = 'Issue', status = 'Active', author = '', files = [] }) {
  return {
    guid: uuid(), title, type, status, description, author, created: now(),
    modified: null, modifiedBy: null, assignedTo: null, priority: null, index: null,
    comments: [], viewpoints: [], doc: null, extra: new Map(), files,
  };
}

export function newComment(author, textValue, viewpointGuid = null) {
  return { guid: uuid(), date: now(), author, text: textValue, viewpointGuid };
}

/**
 * A viewpoint for new topics: the selected components, and the camera when
 * the viewer supplied one (in IFC project coordinates, metres, Z up).
 */
export function newViewpoint({ selection = [], camera = null, snapshotData = null }) {
  const guid = uuid();
  return {
    guid, file: 'viewpoint.bcfv',
    snapshot: snapshotData ? 'snapshot.png' : null, snapshotData,
    selection, camera, doc: null,
  };
}

export function touch(topic, author) {
  topic.modified = now();
  topic.modifiedBy = author;
}

export const timestamp = now;
