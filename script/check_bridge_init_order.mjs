// A module that runs code AS IT LOADS — registering a hook in another module, say — can run before
// that module's own body in the bundle, and the other module's `let HOOK = null` then wipes what was
// registered. Which modules come first is the bundler's to decide, and an import added or dropped
// anywhere reorders them: dropping unused imports once moved web-animations.js ahead of cascade.js,
// and the oracle's layout silently stopped seeing every engine-run animation.
//
// So the built bundle is read here, after esbuild: every top-level call made while the bundle loads,
// followed through the functions it calls, and every module-level variable those assign whose
// declaration (with its initialiser) comes LATER in the bundle is an error. Line-based on esbuild's
// IIFE output — a top-level statement sits at two spaces of indent.
import fs from 'node:fs';

const file = process.argv[2] || 'lib/capybara/simulated/js/bridge.bundle.js';
const lines = fs.readFileSync(file, 'utf8').split('\n');
const IDENT = '[A-Za-z_$][\\w$]*';
const declaredAt = new Map();   // module-level variable → the line its initialiser runs on
const bodies = new Map();       // top-level function → its body's lines
for (let i = 0; i < lines.length; i++) {
  let m = new RegExp(`^  (?:var|let|const) (${IDENT})\\s*=`).exec(lines[i]);
  if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
  m = new RegExp(`^  (?:async )?function\\*? (${IDENT})\\(`).exec(lines[i]);
  if (m && !bodies.has(m[1])) {
    const body = [];
    for (let j = i + 1; j < lines.length && !/^  \}/.test(lines[j]); j++) body.push(lines[j]);
    bodies.set(m[1], body);
  }
}
const ASSIGN = new RegExp(`(?:^|[^\\w$.])(${IDENT})\\s*(?:=(?!=)|\\+\\+|--|[-+*/|&]=)`, 'g');
const CALL = new RegExp(`(?:^|[^\\w$.])(${IDENT})\\(`, 'g');
// What a call to `name` can assign, through every top-level function it calls in turn.
function assignedBy(name, seen = new Set()) {
  if (seen.has(name) || !bodies.has(name)) return seen;
  seen.add(name);
  for (const line of bodies.get(name)) for (const [, callee] of line.matchAll(CALL)) assignedBy(callee, seen);
  return seen;
}
const problems = [];
for (let i = 0; i < lines.length; i++) {
  const m = new RegExp(`^  (${IDENT})\\(`).exec(lines[i]);
  if (!m || !bodies.has(m[1])) continue;
  for (const fn of assignedBy(m[1])) {
    for (const line of bodies.get(fn)) {
      for (const [, v] of line.matchAll(ASSIGN)) {
        const at = declaredAt.get(v);
        if (at !== undefined && at > i) {
          problems.push(`${file}:${i + 1}: \`${m[1]}()\` runs as the bundle loads and assigns \`${v}\` (in \`${fn}\`), ` +
                        `whose declaration at line ${at + 1} runs later and resets it`);
        }
      }
    }
  }
}
for (const p of [...new Set(problems)]) console.error(p);
if (problems.length) {
  console.error('\nRegister the hook when it is first needed, or from a function the runtime calls after the bundle has loaded.');
  process.exit(1);
}
console.log(`${file}: no load-time assignment to a variable initialised later`);
