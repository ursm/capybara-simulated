# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The platform's functions read as a browser's own (Chrome measured 2026-11-18): an attribute's accessors named
# `get x` / `set x` (Web IDL §3.7.6) — a CSS property's on CSSStyleProperties too — `console`'s methods named after
# them, `Intl.DateTimeFormat` whatever the driver's time zone stands it in with, and each one's source
# `function NAME() { [native code] }`, the bindings' JavaScript no page's to read — a frame's read through the page's
# `Function.prototype.toString` as well. A page's own functions, and what is no function, read as ever.
RSpec.describe "the platform's functions" do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe srcdoc="<p>x"></iframe>']] }) }

  def read(js) = session.evaluate_script(js)

  it 'are named as Web IDL names them' do
    session.visit '/'
    expect(read(<<~JS)).to eq(['get color', 'set color', 'get webkitAlignContent', 'get title', 'set title', %w[log debug error info warn], 'DateTimeFormat', 0, true])
      (() => {
        const d = (o, k) => Object.getOwnPropertyDescriptor(o, k);
        const css = CSSStyleProperties.prototype;
        return [d(css, 'color').get.name, d(css, 'color').set.name, d(css, 'webkitAlignContent').get.name,
                d(Document.prototype, 'title').get.name, d(Document.prototype, 'title').set.name,
                ['log', 'debug', 'error', 'info', 'warn'].map((k) => console[k].name),
                Intl.DateTimeFormat.name, Intl.DateTimeFormat.length,
                new Intl.DateTimeFormat().constructor === Intl.DateTimeFormat];
      })()
    JS
  end

  it 'read as native code, a page\'s own as it wrote them' do
    session.visit '/'
    got = read(<<~JS)
      (() => {
        const d = (o, k) => Object.getOwnPropertyDescriptor(o, k);
        const f = frames[0];
        return [String(Document.prototype.querySelector), String(Event), String(d(Node.prototype, 'nodeType').get), String(console.log),
                String(Intl.DateTimeFormat), String(Function.prototype.toString), Function.prototype.toString.call(f.Document.prototype.createElement),
                String(function mine() { return 1; }), String(Math.max),
                (() => { try { Function.prototype.toString.call({}); return 'none'; } catch (e) { return e.name; } })()];
      })()
    JS
    expect(got).to eq([
      'function querySelector() { [native code] }', 'function Event() { [native code] }', 'function get nodeType() { [native code] }',
      'function log() { [native code] }', 'function DateTimeFormat() { [native code] }', 'function toString() { [native code] }',
      'function createElement() { [native code] }', 'function mine() { return 1; }', 'function max() { [native code] }', 'TypeError'
    ])
  end
end
