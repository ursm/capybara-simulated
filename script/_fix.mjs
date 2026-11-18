import { parse } from 'acorn';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const dir = 'lib/capybara/simulated/js/src';
// per-site overrides: file:line -> kind (new | page | none)
const OVR = {
  'native-query-shadow.js:745': 'new', 'workers.js:714': 'new', 'events.js:132': 'new', 'events.js:1023': 'new',
  'cssom.js:289': 'new', 'dispatch.js:471': 'new', 'sw-client.js:387': 'new', 'layout.js:568': 'new', 'form-data.js:48': 'new',
  'webidl.js:1075': 'page', 'webidl.js:608': 'none', 'dispatch.js:340': 'page',
  'dom-nodes.js:2458': 'new', 'dom-nodes.js:3668': 'new', 'html-input.js:57': 'new', 'html-input.js:105': 'new',
  'blob.js:197': 'page', 'blob.js:207': 'page', 'form-fields.js:855': 'page',
  'events.js:595': 'page', 'font-face.js:267': 'page', 'broadcast-channel.js:24': 'page',
  'navigator.js:112': 'page', 'media.js:226': 'page', 'media.js:182': 'page',
};
const edits = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'intrinsics.js')) {
  const src = readFileSync(`${dir}/${f}`, 'utf8');
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const list = [];
  const walk = (n, inFn, parent, key, decl) => {
    if (!n || typeof n.type !== 'string') return;
    const fn = inFn || /Function/.test(n.type);
    const site = `${f}:${n.loc.start.line}`;
    const isEmpty = n.type === 'ArrayExpression' && n.elements.length === 0;
    const isCtor = (n.type === 'NewExpression' || n.type === 'CallExpression') && n.callee.type === 'Identifier' && n.callee.name === 'Array';
    // setPrototypeOf([], null)
    if (inFn && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'setPrototypeOf'
        && n.arguments[0]?.type === 'ArrayExpression' && n.arguments[0].elements.length === 0 && n.arguments[1]?.type === 'Literal' && n.arguments[1].value === null) {
      if (!(f === 'engine.js' && decl === 'building')) list.push([n.start, n.end, 'newList()']);
      return;
    }
    if (inFn && (isEmpty || isCtor)) {
      let kind = OVR[site];
      const pc = parent.type, callee = (parent.callee && (parent.callee.name || parent.callee.property?.name)) || '';
      if (!kind) {
        if (isCtor) kind = 'newn';
        else if ((pc === 'CallExpression' || pc === 'NewExpression') && ['reflectApply', 'reflectConstruct', 'method', 'compileHandler', 'serializeWithTransfer', 'importNode', 'rehydrateArgs'].includes(callee)) kind = 'none';
        else if (pc === 'VariableDeclarator' || pc === 'AssignmentExpression' || pc === 'Property') kind = 'new';
        else kind = 'page';
      }
      const text = kind === 'new' ? 'newList()' : kind === 'page' ? 'pageList()' : kind === 'none' ? 'NO_ARGUMENTS'
        : `newList(${src.slice(n.arguments[0].start, n.arguments[0].end)})`;
      list.push([n.start, n.end, text]);
      return;
    }
    const d = n.type === 'VariableDeclarator' && n.id.type === 'Identifier' ? n.id.name : decl;
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, fn, n, k, d)); else if (v && typeof v.type === 'string') walk(v, fn, n, k, d); }
  };
  walk(ast, false, null, null, null);
  if (!list.length) continue;
  let out = src;
  for (const [s, e, t] of list.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + t + out.slice(e);
  writeFileSync(`${dir}/${f}`, out);
  edits[f] = list.map((x) => x[2]);
}
for (const [f, l] of Object.entries(edits)) console.log(f, [...new Set(l)].join(' '), l.length);
