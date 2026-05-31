// Dev-time generator: distil the WebIDL of every web spec into a flat
// per-interface member map the IDL-coverage spec checks the driver against.
//
//   node script/gen_idl_surface.mjs
//
// Reads @webref/idl (the curated WebIDL of every web platform spec) and
// writes spec/support/idl_members.json. That file is committed; @webref/idl
// is a devDependency only, so running the spec needs no Node toolchain —
// same "generate at build time, consume the artifact" model as the JS
// bundles. Re-run after bumping @webref/idl to refresh the surface.
//
// Output shape:
//   {
//     "_meta": { "webrefVersion": "...", "interfaceCount": N },
//     "Navigator": {
//       "members":    ["clipboard", "userAgent", ...],   // instance members
//       "static":     ["..."],                            // members on the ctor
//       "inheritance": "ParentInterface" | null,
//       "mixins":     ["NavigatorID", ...],
//       "exposed":    true
//     },
//     ...
//   }
//
// Members are the interface's OWN attributes + named operations (plus those
// folded in from mixins via `includes`). Inherited members are deliberately
// NOT flattened in: the coverage spec probes each member with `name in
// instance`, so the prototype chain covers inheritance for free, and listing
// a member only under its declaring interface keeps the surface honest.

import { parseAll } from '@webref/idl';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'spec', 'support', 'idl_members.json');

function webrefVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@webref', 'idl', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// A named, instance-or-static member we care about: attributes and named
// operations. Skip constructors, stringifiers/iterables/getters without a
// name, and consts (consts live on both ctor and instance but aren't the
// "does this API exist" signal we're after).
function memberName(m) {
  if (m.type === 'attribute') return m.name || null;
  if (m.type === 'operation') {
    // special getters/setters/deleters with no identifier aren't probeable
    // by name; named operations (including those also marked `special`) are.
    return m.name || null;
  }
  return null;
}

async function main() {
  const all = await parseAll();

  // name -> { members:Set, static:Set, inheritance, mixins:Set, exposed }
  const interfaces = new Map();
  // mixin name -> { members:Set, static:Set }
  const mixins = new Map();
  // target interface -> [mixin names] from `X includes Y;`
  const includes = new Map();

  const ensureIface = (name) => {
    let e = interfaces.get(name);
    if (!e) {
      e = { members: new Set(), static: new Set(), inheritance: null, mixins: new Set(), exposed: true };
      interfaces.set(name, e);
    }
    return e;
  };
  const ensureMixin = (name) => {
    let e = mixins.get(name);
    if (!e) { e = { members: new Set(), static: new Set() }; mixins.set(name, e); }
    return e;
  };

  const collectMembers = (target, def) => {
    for (const m of def.members || []) {
      const n = memberName(m);
      if (!n) continue;
      (m.special === 'static' ? target.static : target.members).add(n);
    }
  };

  for (const defs of Object.values(all)) {
    for (const def of defs) {
      switch (def.type) {
        case 'interface': {
          const e = ensureIface(def.name);
          if (!def.partial && def.inheritance) e.inheritance = def.inheritance;
          collectMembers(e, def);
          break;
        }
        case 'interface mixin': {
          collectMembers(ensureMixin(def.name), def);
          break;
        }
        case 'includes': {
          const list = includes.get(def.target) || [];
          list.push(def.includes);
          includes.set(def.target, list);
          break;
        }
        default:
          break; // dictionaries, enums, typedefs, callbacks, namespaces — out of scope here
      }
    }
  }

  // Fold mixin members into their including interfaces.
  for (const [target, mixinNames] of includes) {
    const e = interfaces.get(target);
    if (!e) continue;
    for (const mx of mixinNames) {
      const m = mixins.get(mx);
      if (!m) continue;
      e.mixins.add(mx);
      for (const n of m.members) e.members.add(n);
      for (const n of m.static) e.static.add(n);
    }
  }

  const out = {
    _meta: { webrefVersion: webrefVersion(), interfaceCount: interfaces.size }
  };
  for (const [name, e] of [...interfaces].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[name] = {
      members: [...e.members].sort(),
      static: [...e.static].sort(),
      inheritance: e.inheritance,
      mixins: [...e.mixins].sort()
    };
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${OUT}: ${interfaces.size} interfaces (webref ${out._meta.webrefVersion})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
