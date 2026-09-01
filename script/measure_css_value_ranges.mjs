// Re-derive the three MEASURED value-range tables in gen_css_property_data.js by asking a real
// browser, because mdn-data does not carry the facts: it records `line-height: normal | <number> |
// <length> | <percentage>` with no bound at all, and `outline-width: <line-width>` with the bound
// one level down in a syntax it does not expand. What a browser accepts is the only source.
//
//   node script/measure_css_value_ranges.mjs [--chrome /path/to/chrome]
//
// Prints the three arrays and the skipped-property list, ready to paste into
// gen_css_property_data.js, plus the browser version they were measured with. Re-run it when the
// tables look stale (a property mdn adds, or a browser that starts implementing one of the 44).
//
// Each longhand mdn knows is offered a set of probe values through `el.style.setProperty`; a value
// the browser keeps is one its grammar accepts. A property the browser does NOT implement rejects
// everything, including its own keywords — a different fact, and one that would poison every table
// here (`box-flex: 0`, this driver's own initial value, was rejected for a while because of it), so
// `CSS.supports(prop, 'inherit')` filters those out first.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chrome = process.argv.includes('--chrome')
  ? process.argv[process.argv.indexOf('--chrome') + 1]
  : '/usr/bin/google-chrome-stable';
const mdnPath = require.resolve('mdn-data/css/properties.json', { paths: [require.resolve('css-tree')] });
const props = JSON.parse(readFileSync(mdnPath, 'utf8'));
const longhands = Object.keys(props)
  .filter((n) => !n.startsWith('-') && !Array.isArray(props[n].computed))
  .sort();

// `-1s` and `1deg` are in the set so a time- or angle-valued property is not read as "takes no
// number" merely because it refuses a length.
const NEGATIVE = ['-1px', '-1', '-1%', '-1s'];
const POSITIVE = ['1px', '1', '1%', '1s'];
const EXTRA    = ['0', '1deg'];

const page = `<!doctype html><meta charset=utf-8><pre id=out></pre><script>
const NAMES = ${JSON.stringify(longhands)};
const NEG = ${JSON.stringify(NEGATIVE)}, POS = ${JSON.stringify(POSITIVE)}, EXTRA = ${JSON.stringify(EXTRA)};
const el = document.createElement('div');
document.body.appendChild(el);
const keeps = (prop, v) => { el.style.setProperty(prop, ''); el.style.setProperty(prop, v);
                             return el.style.getPropertyValue(prop) !== ''; };
const rows = NAMES.map((prop) => ({
  prop,
  supported: CSS.supports(prop, 'inherit'),
  neg:   NEG.map((v) => keeps(prop, v)),
  pos:   POS.map((v) => keeps(prop, v)),
  extra: EXTRA.map((v) => keeps(prop, v))
}));
document.getElementById('out').textContent = JSON.stringify({ ua: navigator.userAgent, rows });
</` + `script>`;

const dir = mkdtempSync(join(tmpdir(), 'csim-value-ranges-'));
const file = join(dir, 'census.html');
writeFileSync(file, page);
const dom = execFileSync(chrome, ['--headless', '--disable-gpu', '--dump-dom', `file://${file}`],
                         { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
if (!match) throw new Error('the census page produced no output — did the browser run it?');
const { ua, rows } = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                                        .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

const supported = rows.filter((r) => r.supported);
// A property is NON-NEGATIVE when it refuses a negative in every form it otherwise accepts…
const negativeInvalid = supported.filter((r) =>
  r.pos.some((k, i) => k && !r.neg[i]) && !r.pos.some((k, i) => k && r.neg[i])).map((r) => r.prop);
// …NUMERIC-free when it refuses every numeric form there is…
const numericInvalid = supported.filter((r) =>
  ![...r.pos, ...r.neg, ...r.extra].some(Boolean)).map((r) => r.prop);
// …and UNITLESS-free when it refuses a bare number while taking a dimensioned one.
const unitlessInvalid = supported.filter((r) =>
  !r.extra[0] && (r.pos[0] || r.pos[3] || r.extra[1])).map((r) => r.prop);

const fmt = (names) => names.map((n) => `  '${n}',`).join('\n');
console.log(`// measured with ${ua}`);
console.log(`const NEGATIVE_INVALID = [\n${fmt(negativeInvalid)}\n];\n`);
console.log(`const NUMERIC_INVALID = [\n${fmt(numericInvalid)}\n];\n`);
console.log(`const UNITLESS_NUMBER_INVALID = [\n${fmt(unitlessInvalid)}\n];\n`);
console.log(`// not implemented by this browser, so it has no opinion to record (${rows.length - supported.length}):`);
console.log(rows.filter((r) => !r.supported).map((r) => `//   ${r.prop}`).join('\n'));
