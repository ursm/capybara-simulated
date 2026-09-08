# frozen_string_literal: true

# Store-flip foundation: a NATIVE-BACKED `_attrs`. `__dom.attrsView(nid)` returns an object whose
# attribute storage lives in the Rust arena, reached through a C++ named-property interceptor
# (get / set / query / delete / enumerate / descriptor) — not a JS Proxy (no per-trap JS dispatch),
# so it is a faithful stand-in for the native-backed-node endgame AND drop-in for the plain `_attrs`
# object every DOM idiom uses. This pins that its object semantics match a plain JS object exactly:
# named read/write, `in`, hasOwnProperty, delete, `for..in` / Object.keys ORDER, Object.assign.
#
# V8 only. Run: CSIM_JS_ENGINE=v8 bundle exec rspec spec/native_attrs_view_spec.rb

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native-backed _attrs view (store-flip foundation)', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  let(:app) { Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><title>t</title>']] } }.to_app }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  def probe(js)
    session.evaluate_script(<<~JS)
      (function () {
        __dom.resetArena();
        const nid = __dom.importNode('DIV', 'div', '', false, -1, ['class', 'a b', 'id', 'x', 'data-i', '5']);
        const v = __dom.attrsView(nid);
        return (#{js});
      })()
    JS
  end

  it 'reads named + computed keys, undefined for absent (the sentinel contract)' do
    expect(probe("v.class")).to eq('a b')
    expect(probe("v.id")).to eq('x')
    expect(probe("v['data-i']")).to eq('5')
    expect(probe("v.missing === undefined")).to be(true)
    expect(probe("v['nope'] === undefined")).to be(true)
  end

  it 'answers `in` and hasOwnProperty' do
    expect(probe("'class' in v")).to be(true)
    expect(probe("'missing' in v")).to be(false)
    expect(probe("Object.prototype.hasOwnProperty.call(v, 'id')")).to be(true)
    expect(probe("Object.prototype.hasOwnProperty.call(v, 'missing')")).to be(false)
    expect(probe("v.hasOwnProperty('data-i')")).to be(true)
  end

  it 'enumerates in insertion order (Object.keys / for..in) — the serialization contract' do
    expect(probe("JSON.stringify(Object.keys(v))")).to eq('["class","id","data-i"]')
    expect(probe("(function(){ const ks=[]; for (const k in v) ks.push(k); return JSON.stringify(ks); })()")).to eq('["class","id","data-i"]')
  end

  it 'writes (set trap → arena) including a bypass-style computed write' do
    expect(probe("(v.title = 'hi', v.title)")).to eq('hi')
    expect(probe("(v['data-x'] = 'y', v['data-x'])")).to eq('y')
    # a new key appends to the end (insertion order preserved)
    expect(probe("(v.title = 'hi', JSON.stringify(Object.keys(v)))")).to eq('["class","id","data-i","title"]')
    # an existing key updates in place, does NOT move to the end
    expect(probe("(v.class = 'z', JSON.stringify(Object.keys(v)) + '|' + v.class)")).to eq('["class","id","data-i"]|z')
  end

  it 'deletes (delete trap → arena)' do
    expect(probe("(delete v.class, v.class === undefined)")).to be(true)
    expect(probe("(delete v.class, JSON.stringify(Object.keys(v)))")).to eq('["id","data-i"]')
    expect(probe("(delete v.class, 'class' in v)")).to be(false)
  end

  it 'Object.assign snapshots to a plain object identically' do
    expect(probe("JSON.stringify(Object.assign({}, v))")).to eq('{"class":"a b","id":"x","data-i":"5"}')
  end

  it 'stays truthy (the `el._attrs && ...` guard contract) and round-trips a write' do
    expect(probe("!!v")).to be(true)
    expect(probe("typeof v")).to eq('object')
    # a write through the view is read back through it (set → arena → get)
    expect(probe("(v.class = 'card', v.class)")).to eq('card')
  end
end
