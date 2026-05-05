#!/usr/bin/env ruby
# Minimal segfault repro for Quickjs::VM under sustained load.
# Loads jQuery 1.12 into a single VM, registers a handful of Ruby
# callbacks via define_function, and repeats eval / call cycles
# until the process dies. Iterations needed in our env: ~600.
#
# Usage: bundle exec ruby pure_quickjs_repro.rb [ITER]

require 'quickjs'
require 'rubygems'

# Locate jQuery 1.12 inside the Capybara gem (any version that bundles it).
spec = Gem::Specification.find_by_name('capybara')
jquery_path = File.join(spec.gem_dir, 'lib/capybara/spec/public/jquery.js')
jquery_src  = File.binread(jquery_path)

ITER = (ARGV[0] || 1500).to_i

# A "browser-ish" environment — just enough that jQuery 1.12 loads
# without throwing. Mirrors capybara-simulated/v2's shim surface but
# stripped to the minimum jQuery boot needs.
BOOTSTRAP = <<~JS
  globalThis.window     = globalThis;
  globalThis.self       = globalThis;
  globalThis.navigator  = {userAgent: 'repro', language: 'en-US'};
  globalThis.screen     = {width: 1024, height: 768};
  globalThis.location   = {href: 'http://example.com/', host: 'example.com', pathname: '/'};
  globalThis.history    = {pushState: () => {}, replaceState: () => {}};
  globalThis.localStorage = {getItem: () => null, setItem: () => {}};
  globalThis.sessionStorage = {getItem: () => null, setItem: () => {}};
  globalThis.getComputedStyle = () => ({getPropertyValue: () => '', length: 0});
  globalThis.matchMedia = () => ({matches: false, addListener: () => {}});

  // Minimal Element / document.
  class _Element {
    constructor(name) {
      this.tagName = (name || '').toUpperCase();
      this.nodeName = this.tagName;
      this.nodeType = 1;
      this._children = [];
      this._attrs = {};
      this.style = {cssText: '', getPropertyValue: () => '', setProperty: () => {}, removeProperty: () => {}};
    }
    get children()   { return this._children; }
    get childNodes() { return this._children; }
    get firstChild() { return this._children[0] || null; }
    get parentNode() { return null; }
    get ownerDocument() { return globalThis.document; }
    appendChild(c)  { this._children.push(c); return c; }
    removeChild(c)  { const i = this._children.indexOf(c); if (i>=0) this._children.splice(i,1); return c; }
    insertBefore(n, r) { return this.appendChild(n); }
    cloneNode()     { return new _Element(this.tagName); }
    getAttribute(n) { return this._attrs[n] != null ? this._attrs[n] : null; }
    setAttribute(n, v) { this._attrs[n] = String(v); }
    removeAttribute(n) { delete this._attrs[n]; }
    hasAttribute(n) { return n in this._attrs; }
    get attributes() {
      const out = [];
      for (const k of Object.keys(this._attrs)) {
        const a = {name: k, value: this._attrs[k], specified: true, expando: false};
        out.push(a); out[k] = a;
      }
      return out;
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
    getElementsByTagName(t) {
      const want = String(t).toUpperCase();
      const out = [];
      const walk = el => { for (const c of el._children) { if (c.tagName === want || want === '*') out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    getElementsByClassName() { return []; }
    querySelector()    { return null; }
    querySelectorAll() { return []; }
    matches() { return false; }
    contains(o) { return false; }
    closest()   { return null; }
    getClientRects() { return []; }
    getBoundingClientRect() { return {top:0,right:0,bottom:0,left:0,width:0,height:0,x:0,y:0}; }
    get innerHTML() { return ''; }
    set innerHTML(v) {}
    get outerHTML() { return '<' + this.tagName.toLowerCase() + '/>'; }
    get textContent() { return ''; }
    set textContent(v) {}
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
  }
  globalThis.Element = _Element;
  globalThis.HTMLElement = _Element;
  globalThis.Node = _Element;

  const _doc = new _Element('html');
  _doc.nodeType = 9;
  _doc.readyState = 'complete';
  _doc.compatMode = 'CSS1Compat';
  _doc.documentElement = new _Element('html');
  _doc.documentElement.style = {cssText: '', getPropertyValue: () => ''};
  _doc.body = _doc.documentElement.appendChild(new _Element('body'));
  _doc.head = _doc.documentElement.appendChild(new _Element('head'));
  _doc.defaultView = globalThis;
  _doc.implementation = {createHTMLDocument: () => _doc};
  _doc.createElement = n => new _Element(n);
  _doc.createTextNode = t => ({nodeType: 3, nodeValue: String(t), data: String(t), parentNode: null});
  _doc.createComment = t => ({nodeType: 8, nodeValue: String(t), data: String(t)});
  _doc.createDocumentFragment = () => { const f = new _Element('#document-fragment'); f.nodeType = 11; return f; };
  _doc.getElementById = id => null;
  _doc.getElementsByTagName = t => _doc.documentElement.getElementsByTagName(t);
  globalThis.document = _doc;

  // Timer queue (stub, never drained).
  let _tid = 0; const _timers = new Map();
  globalThis.setTimeout    = (fn, ms) => { const id = ++_tid; _timers.set(id, fn); __reportTimer(id); return id; };
  globalThis.setInterval   = (fn, ms) => { const id = ++_tid; _timers.set(id, fn); __reportTimer(id); return id; };
  globalThis.clearTimeout  = id => _timers.delete(id);
  globalThis.clearInterval = id => _timers.delete(id);
  globalThis.requestAnimationFrame  = fn => globalThis.setTimeout(fn, 16);
  globalThis.cancelAnimationFrame   = id => _timers.delete(id);
JS

vm = Quickjs::VM.new(features: [
  Quickjs::POLYFILL_URL,
  Quickjs::POLYFILL_ENCODING,
  Quickjs::POLYFILL_CRYPTO
])

# Ruby-side callbacks. The repro grew out of a context where these
# were getting hit on every event dispatch, so leaving them in
# matches that workload — drop them if you want to bisect.
timer_count = 0
vm.define_function('__reportTimer') { |_id| timer_count += 1; nil }
vm.define_function('__notifyMutationActive') { |_| nil }
vm.define_function('__setListenedType')      { |_t, _a| nil }
vm.define_function('__setTimersActive')      { |_a| nil }

vm.eval_code(BOOTSTRAP)

def safely(vm, code)
  vm.eval_code(code)
rescue Quickjs::RuntimeError, ArgumentError
  # Bootstrap is intentionally minimal — jQuery probes fail mid-load
  # but the VM keeps a partially-populated state, which is exactly
  # what the production driver also lives with. The point of this
  # repro is the *cumulative* effect across iterations, not jQuery
  # working perfectly.
end

safely(vm, jquery_src + "\n;void 0")
puts "iter 0: jQuery loaded once (#{jquery_src.bytesize} bytes). " \
     "rss=#{`ps -o rss= -p #{$$}`.strip} KB"

# Each iteration mimics a fresh page-load that re-runs jQuery into the
# same VM and pokes a few common code paths.
ITER.times do |i|
  safely(vm, jquery_src + "\n;void 0")
  safely(vm, 'jQuery("body").addClass("x").removeClass("x");void 0')
  safely(vm, 'jQuery("body").on("click", function(){});void 0')
  safely(vm, 'jQuery("body").trigger("click");void 0')
  if ((i + 1) % 50).zero?
    puts "iter #{i + 1}: timers seen=#{timer_count}, " \
         "rss=#{`ps -o rss= -p #{$$}`.strip} KB"
  end
end

puts 'survived'
