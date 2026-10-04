# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A node's object is a wrapper of a handle on V8's C++ heap (node_handle.rs): when V8 collects the object it collects the
# handle, and the node's arena slot is freed — at the next node the page makes. That holds for a subtree a script builds
# detached and drops, whichever way it built it: one whose children came by `appendChild` was kept alive by the handle
# table Ruby names nodes by, which registered every inserted node, in a document or not.
RSpec.describe 'node handles' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><p id=keep>k</p>']] } }

  it 'frees the slots of nodes V8 collected, and keeps those of nodes a page holds' do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.__nids = {};
      const make = {
        text:     () => document.createTextNode('x'),
        element:  () => document.createElement('div'),
        appended: () => { const e = document.createElement('div'); e.appendChild(document.createElement('b')); return e; },
        fragment: () => { const f = document.createDocumentFragment(); f.appendChild(document.createTextNode('x')); return f; },
      };
      for (const kind in make) {
        __nids[kind] = [];
        for (let i = 0; i < 500; i++) { const n = make[kind](); if (i % 50 === 0) __nids[kind].push(n._nid); }
      }
      window.__kept = document.getElementById('keep');
    JS
    s.evaluate_script('0')   # (…the script's task over: what it left for the settle is let go)
    runtime = s.driver.browser.instance_variable_get(:@runtime)
    2.times { runtime.ctx.low_memory_notification }
    got = s.evaluate_script(<<~JS)
      (() => {
        document.createElement('span');   // (…which frees what was collected)
        const freed = {};
        for (const kind in __nids) freed[kind] = __nids[kind].filter((nid) => __dom.inspectNode(nid) == null).length;
        return [freed, __dom.inspectNode(__kept._nid) != null];
      })()
    JS
    expect(got).to eq([{'text' => 10, 'element' => 10, 'appended' => 10, 'fragment' => 10}, true])
  end
end
