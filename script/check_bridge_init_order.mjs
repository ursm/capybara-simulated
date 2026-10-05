// A module that runs code AS IT LOADS — registering a hook in another module, say — can run before
// that module's own body in the bundle, and the other module's `let HOOK = null` then wipes what was
// registered. Which modules come first is the bundler's to decide, and an import added or dropped
// anywhere reorders them: dropping unused imports once moved web-animations.js ahead of cascade.js,
// and the oracle's layout silently stopped seeing every engine-run animation.
//
// So the built bundle is read here, after esbuild: every top-level statement runs as the bundle
// loads, and it — through every function it reaches — must neither write a module-level variable
// whose initialiser runs LATER (the write is wiped: `X = …`, `X.y = …`, `X[k] = …`, `X.push(…)` …)
// nor call a function held in one (it is still `undefined`). esbuild turns every top-level
// `let` / `const` into `var`, so neither shows up as an error at run time.
//
// Line-based on esbuild's IIFE output, where a top-level statement starts at two spaces of indent.
// A statement that only DEFINES a function (`globalThis.f = function …`, a callback passed along)
// runs none of its body at load, so a statement is followed into the functions it CALLS only when
// it defines none itself; from there every call a reached body makes counts, whatever branch it sits
// on.
import fs from 'node:fs';

const file = process.argv[2] || 'lib/capybara/simulated/js/bridge.bundle.js';
const lines = fs.readFileSync(file, 'utf8').split('\n');
const IDENT = '[A-Za-z_$][\\w$]*';
const TOP = /^  \S/;
const isComment = (line) => /^\s*\/\//.test(line);

// The lines of the top-level construct starting at `i`: up to the line that closes it at the same indent, or the
// line alone where it closes on the line it opens.
function blockAt(i) {
  if (/[{(\[]\s*$/.test(lines[i])) {
    let j = i + 1;
    while (j < lines.length && !/^  [}\])]/.test(lines[j])) j++;
    return lines.slice(i, j + 1);
  }
  let j = i + 1;
  while (j < lines.length && !TOP.test(lines[j]) && lines[j] !== '})();') j++;
  return lines.slice(i, j);
}

const declaredAt = new Map();   // module-level variable → the line its initialiser runs on
const bodies = new Map();       // top-level function (declared, or a `var` holding one) → its lines
for (let i = 0; i < lines.length; i++) {
  let m = new RegExp(`^  (?:async )?function\\*? (${IDENT})\\(`).exec(lines[i]);
  if (m) { if (!bodies.has(m[1])) bodies.set(m[1], blockAt(i).slice(1)); continue; }
  m = new RegExp(`^  var (${IDENT})\\s*=\\s*(.*)$`).exec(lines[i]);
  if (!m) continue;
  if (!declaredAt.has(m[1])) declaredAt.set(m[1], i);
  if (/^(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/.test(m[2]) && !bodies.has(m[1])) bodies.set(m[1], blockAt(i));
}

const CALLED = new RegExp(`(?<![\\w$.])(${IDENT})(?=\\s*\\()`, 'g');
const WRITE = new RegExp(`(?<![\\w$.])(${IDENT})\\s*(?:\\.(?:push|unshift|add|set|delete|clear|splice)\\(|` +
                         `(?:\\.[\\w$]+|\\[[^\\]]*\\])*\\s*(?:=(?![=>])|\\+\\+|--|[-+*/|&]=))`, 'g');
const METHOD = /^\s+(?:static\s+|async\s+|get\s+|set\s+)*(?!(?:if|for|while|switch|catch|with)\b)[\w$]+\s*\([^)]*\)\s*\{\s*$/;
const LOCAL = new RegExp(`(?:\\b(?:let|const|var)\\s+|[(,]\\s*)(${IDENT})(?=\\s*[=,);])`, 'g');

// A method's definition (`dispatchEvent(event) { …`, `get x() { …`): its name is no call — a class a function makes
// may name a method as a top-level function is named — so it is left out, and the body after it kept.
const METHOD_HEAD = /^(\s+)(?:static\s+|async\s+|get\s+|set\s+)*[\w$]+\s*\([^)]*\)\s*\{/;

// Every top-level function a call to `name` can reach.
function reach(name, seen) {
  if (seen.has(name) || !bodies.has(name)) return;
  seen.add(name);
  for (const line of bodies.get(name)) {
    if (isComment(line)) continue;
    for (const [, n] of line.replace(METHOD_HEAD, '$1{').matchAll(CALLED)) reach(n, seen);
  }
}

const problems = new Set();
for (let i = 0; i < lines.length; i++) {
  if (!TOP.test(lines[i]) || isComment(lines[i])) continue;
  if (/^  (?:async )?function\b|^  class\b|^  [}\])]/.test(lines[i])) continue;
  if (/^  __name\(/.test(lines[i])) continue;              // `--keep-names` naming a function: no call
  const m = new RegExp(`^  var (${IDENT})\\s*=\\s*(.*)$`).exec(lines[i]);
  if (m && bodies.has(m[1])) continue;                     // a function held in a variable: defined, not run
  if (m && /^class\b/.test(m[2])) continue;               // …and a class: its methods run when called
  const stmt = blockAt(i).filter((line) => !isComment(line));
  // (…a method written shorthand — `get() {`, `handleEvent(e) {` — defines one too)
  const defines = stmt.some((line) => /\bfunction\b|=>/.test(line) || METHOD.test(line));
  const reached = new Set();
  if (!defines) for (const line of stmt) for (const [, n] of line.matchAll(CALLED)) reach(n, reached);
  else {
    // …but the call it STARTS with runs all the same — and passing a callback is what registering a hook looks like
    // (`onX((e) => …)`, `setX(function …)`): the registration's own write is the one to see.
    const lead = new RegExp(`^  (?:var ${IDENT}\\s*=\\s*)?(${IDENT})\\(`).exec(stmt[0]);
    if (lead) reach(lead[1], reached);
  }
  for (const fn of reached) {
    const at = declaredAt.get(fn);
    if (at !== undefined && at > i) {
      problems.add(`${file}:${i + 1}: \`${fn}\` is called as the bundle loads, but the variable holding it is ` +
                   `initialised later, at line ${at + 1}`);
    }
  }
  const texts = [['the statement itself', defines ? [stmt[0]] : stmt]];
  for (const fn of reached) texts.push([`\`${fn}\``, bodies.get(fn)]);
  for (const [where, body] of texts) {
    const locals = new Set();
    for (const line of body) for (const [, n] of line.matchAll(LOCAL)) locals.add(n);
    for (const line of body) {
      if (isComment(line)) continue;
      for (const [, v] of line.matchAll(WRITE)) {
        const at = declaredAt.get(v);
        if (at === undefined || at <= i || (where !== 'the statement itself' && locals.has(v))) continue;
        problems.add(`${file}:${i + 1}: this runs as the bundle loads and writes \`${v}\` (in ${where}), whose ` +
                     `initialiser at line ${at + 1} runs later and resets it`);
      }
    }
  }
}
for (const p of problems) console.error(p);
if (problems.size) {
  console.error('\nRegister the hook when it is first needed, or from a function the runtime calls after the bundle has loaded.');
  process.exit(1);
}
console.log(`${file}: nothing written or called at load before its initialiser runs`);
