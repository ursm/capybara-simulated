// URLPattern (URL Pattern Standard), generated from its IDL: the engine's (url_pattern.rs) — a URLPattern object IS
// the engine's pattern, made by `__dom.URLPatternBase` with this interface's prototype: its components parsed,
// canonicalized and compiled there, and a URL matched against them there. A service worker's static router takes one
// given as a condition as it is (sw_router.rs).
import { convertURLPatternArguments, installURLPattern } from './generated/bindings.js';
import { registerInterface } from './webidl.js';

const dom = () => globalThis.__dom;
registerInterface('URLPattern', (o) => dom().urlPatternBrand(o));
export class URLPattern {
  constructor() {
    const [overload, input, ...rest] = convertURLPatternArguments(arguments);
    const [baseURL, options] = overload === 'input_baseURL_options' ? rest : [undefined, rest[0]];
    return Reflect.construct(dom().URLPatternBase, [input, baseURL, options.ignoreCase], new.target);
  }
}
// The components, in url_pattern.rs `COMPONENTS`' order.
const COMPONENTS = ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash'];
const pattern = {
  test: (p, input, baseURL) => dom().urlPatternMatch(p, input, baseURL, true),
  exec: (p, input, baseURL) => dom().urlPatternMatch(p, input, baseURL, false),
  get_hasRegExpGroups: (p) => dom().urlPatternHasRegExpGroups(p)
};
COMPONENTS.forEach((name, i) => {
  pattern[`get_${name}`] = (p) => dom().urlPatternComponent(p, i);
});
installURLPattern(URLPattern, pattern);

globalThis.URLPattern = URLPattern;
