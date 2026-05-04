// Shim for Node's `vm` module. happy-dom uses Script for evaluating page-
// supplied <script> bodies inside its synthetic browser frame. We give
// Script a pass-through implementation that runs the source with a function
// constructor — good enough for the inline scripts the test app emits.
export class Script {
  constructor(source, _options) { this.code = String(source); }
  runInThisContext(_options) {
    return new Function(this.code).call(globalThis);
  }
  runInContext(context, _options) {
    return new Function('with (this) { ' + this.code + ' }').call(context);
  }
  runInNewContext(context, _options) {
    return this.runInContext(context || {});
  }
}
export function createContext(obj) { return obj || {}; }
export function isContext(_obj) { return true; }
export function compileFunction(code, params, _options) {
  const args = (params || []).join(',');
  return new Function(args, code);
}
export default {Script, createContext, isContext, compileFunction};
