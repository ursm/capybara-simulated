import { parse } from 'acorn';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const dir = 'lib/capybara/simulated/js/src';
const sites = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'intrinsics.js')) {
  const src = readFileSync(`${dir}/${f}`, 'utf8');
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const walk = (n, inFn, parent, key) => {
    if (!n || typeof n.type !== 'string') return;
    const fn = inFn || /Function/.test(n.type);
    const isEmpty = n.type === 'ArrayExpression' && n.elements.length === 0;
    const isCtor = (n.type === 'NewExpression' || n.type === 'CallExpression') && n.callee.type === 'Identifier' && n.callee.name === 'Array';
    if (inFn && (isEmpty || isCtor)) {
      let ctx = parent.type;
      if (ctx === 'LogicalExpression') ctx += parent.operator;
      if (ctx === 'CallExpression' || ctx === 'NewExpression') ctx += ':' + (parent.callee.name || parent.callee.property?.name || '?');
      sites.push({ f, line: n.loc.start.line, col: n.loc.start.column, end: n.end, start: n.start, ctx, kind: isCtor ? 'ctor' : 'lit', text: src.split('\n')[n.loc.start.line - 1].trim().slice(0, 150) });
    }
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, fn, n, k)); else if (v && typeof v.type === 'string') walk(v, fn, n, k); }
  };
  walk(ast, false, null, null);
}
writeFileSync(process.argv[2], JSON.stringify(sites, null, 1));
const by = {}; for (const s of sites) by[s.ctx] = (by[s.ctx] || 0) + 1;
console.log(sites.length, by);
