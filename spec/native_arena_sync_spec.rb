# frozen_string_literal: true

# F1a of the store flip: the INCREMENTAL arena-sync primitives (__dom.syncChildren / setAttr /
# removeAttr). The shadow measurement rebuilt the whole arena whenever the DOM changed — far too
# costly to be the store (Redmine: 350ms over 450 rebuilds). The flip instead keeps the arena
# current with per-mutation deltas. This pins that the primitives model the DOM correctly under a
# realistic mutation sequence — insert, remove, MOVE, attribute add/remove — with the arena rebuilt
# exactly ONCE (the initial parse mirror) and every later change applied incrementally.
#
# css-select over the live JS DOM is the oracle: after each mutation the native queryIds result must
# equal css-select's (`__csimCssSelectAll`) — same set, same order — for order-sensitive (:nth-child, sibling
# combinators), attribute, and :empty selectors, so a drift in any primitive shows up immediately.

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# These examples hand-DRIVE the arena (resetArena + their own `__nid` map + syncChildren/setAttr by
# hand), so they need EXCLUSIVE ownership of the isolate-global arena. Native cascade matching is now ON
# BY DEFAULT and co-owns that arena (cascade builds + syncs it), so the two drivers collide — these run
# ONLY with the kill switch (CSIM_NO_NATIVE_CASCADE), the one config where the arena is free. The
# primitives under test are exercised in production by the default path (and covered by WPT + the app
# suites) anyway; this stays as a focused isolation test for the sync primitives themselves.
RSpec.describe 'native arena incremental sync (store-flip F1a)',
  if: ENV['CSIM_NO_NATIVE_CASCADE'] do
  let(:app) {
    html = <<~HTML
      <!doctype html>
      <html><head><title>sync</title></head><body>
        <ul class="list">
          <li class="item" data-k="1">one</li>
          <li class="item" data-k="2">two</li>
          <li class="item" data-k="3">three</li>
        </ul>
        <div class="box"><span class="tag">x</span></div>
        <div class="empty"></div>
      </body></html>
    HTML
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  }

  let(:session) { simulated_session(app) }

  # Build the arena by MIRRORING the parsed document: create every element unlinked
  # (importNode parent -1), then link each parent's children with syncChildren. A
  # document node parents <html> so a document-scoped query includes it. Nothing here rebuilds;
  # subsequent mutations reuse these primitives on just the affected nodes.
  SETUP = <<~JS
    globalThis.__nid = [];   // nid -> node, for mapping native results back
    globalThis.HTML_NS = 'http://www.w3.org/1999/xhtml';
    // Every node — text and comments too, which `:empty` reads — as an unlinked arena node.
    globalThis.mirrorCreate = function (node) {
      if (node.nodeType !== 1) { node.__nid = __dom.createNode(node.nodeType, node.data == null ? '' : node.data, -1); return; }
      const attrs = [];
      const a = node._attrs; for (const k in a) attrs.push(k, a[k]);
      const nid = __dom.importNode(node._localName, node._ns ?? '', -1, attrs);
      node.__nid = nid; __nid[nid] = node;
      for (const c of node.childNodes) mirrorCreate(c);
    };
    globalThis.syncEl = function (el) {
      const kids = [];
      for (const c of el.childNodes) kids.push(c.__nid);
      __dom.syncChildren(el.__nid, kids);
    };
    globalThis.mirrorLink = function (el) { syncEl(el); for (const c of el.children) mirrorLink(c); };
    globalThis.mirrorInit = function () {
      __dom.resetArena(); __nid = [];
      const root = document.documentElement;
      mirrorCreate(root); mirrorLink(root);
      globalThis.__docRoot = __dom.createNode(9, '', -1);
      __dom.syncChildren(__docRoot, [root.__nid]);
    };
    // Create arena nodes for a freshly-inserted subtree, then link it (its own descendants too).
    globalThis.mirrorInsertedSubtree = function (el) { mirrorCreate(el); mirrorLink(el); };
  JS

  # Compare native queryIds (document-scoped) to css-select — same set AND same order.
  CHECK = <<~JS
    (function (sel) {
      const css = __csimCssSelectAll(document, sel);   // css-select alone: querySelectorAll is native
      const ids = __dom.queryIds(__docRoot, sel);
      if (ids === undefined) return 'FALLBACK';
      if (ids === null) return 'INVALID';
      if (ids.length !== css.length) return 'LEN nat=' + ids.length + ' css=' + css.length + ' @ ' + sel;
      for (let i = 0; i < ids.length; i++) {
        if (__nid[ids[i]] !== css[i]) return 'ORDER@' + i + ' ' + sel;
      }
      return 'OK:' + ids.length;
    })
  JS

  def check(sel)
    session.evaluate_script("(#{CHECK})(#{sel.to_json})")
  end

  before do
    session.visit '/'
    session.evaluate_script(SETUP)
    session.evaluate_script('mirrorInit()')
  end

  it 'mirrors the parsed document (baseline parity, order-sensitive)' do
    ['.item', 'li:nth-child(2)', '.list > .item', 'li + li', '.box .tag', 'div:empty', '[data-k="2"]'].each do |sel|
      expect(check(sel)).to start_with('OK:'), "baseline #{sel.inspect}"
    end
  end

  it 'tracks an attribute add / change / remove via setAttr / removeAttr' do
    # add data-k to the box, change an item's data-k, remove one — resync only the touched nodes.
    session.evaluate_script(<<~JS)
      const box = document.querySelector('.box');
      box.setAttribute('data-k', '9'); __dom.setAttr(box.__nid, 'data-k', '9');
      const it2 = document.querySelectorAll('.item')[1];
      it2.setAttribute('data-k', '22'); __dom.setAttr(it2.__nid, 'data-k', '22');
      const it3 = document.querySelectorAll('.item')[2];
      it3.removeAttribute('data-k'); __dom.removeAttr(it3.__nid, 'data-k');
    JS
    ['[data-k="9"]', '[data-k="22"]', '[data-k]', '.item:not([data-k])'].each do |sel|
      expect(check(sel)).to start_with('OK:'), "after attr mutation #{sel.inspect}"
    end
  end

  it 'tracks appendChild / removeChild via syncChildren (order preserved)' do
    session.evaluate_script(<<~JS)
      const list = document.querySelector('.list');
      const li = document.createElement('li'); li.className = 'item'; li.setAttribute('data-k', '4'); li.textContent = 'four';
      list.appendChild(li);
      mirrorInsertedSubtree(li); syncEl(list);              // create the new node, relink the parent
      const first = list.querySelector('.item');
      list.removeChild(first); syncEl(list);                // relink after removal
    JS
    ['.item', 'li:nth-child(1)', 'li:last-child', '[data-k="4"]', '.list > li:nth-child(3)'].each do |sel|
      expect(check(sel)).to start_with('OK:'), "after child mutation #{sel.inspect}"
    end
  end

  it 'tracks a MOVE across parents via syncChildren on both parents (self-healing detach)' do
    session.evaluate_script(<<~JS)
      const tag = document.querySelector('.box .tag');   // move .tag out of .box into .list
      const box = document.querySelector('.box');
      const list = document.querySelector('.list');
      list.appendChild(tag);            // JS move: detaches from box, appends to list
      syncEl(list); syncEl(box);        // relink BOTH parents — order-independent self-heal
    JS
    ['.list .tag', '.box .tag', '.box:empty', '.list > .tag', 'span.tag'].each do |sel|
      expect(check(sel)).to start_with('OK:'), "after move #{sel.inspect}"
    end
    # The move made .box empty and put .tag last under .list — prove both directions.
    expect(check('.box:empty')).to eq('OK:1')
    expect(check('.list > *:last-child')).to eq('OK:1')
  end

  # Review F3: a subtree removed from the tree must not keep a phantom upward chain — an
  # element-rooted query INSIDE the detached subtree must not match a former ancestor. sync_children
  # nulls the .parent of dropped children for exactly this.
  it 'clears the upward chain of a dropped subtree (no phantom ancestor)' do
    result = session.evaluate_script(<<~JS)
      (function () {
        const box = document.querySelector('.box');     // .box > .tag, under <body>
        const tag = box.querySelector('.tag');
        document.body.removeChild(box); syncEl(document.body);   // drop .box; nulls its .parent
        // Element-scoped query inside the detached box: '.tag' matches, but 'body .tag' must NOT
        // (its former <body> ancestor is gone). Native (arena) must agree with css-select (JS DOM).
        const natBare = (__dom.queryIds(box.__nid, '.tag') || []).length;
        const cssBare = __csimCssSelectAll(box, '.tag').length;
        const natAnc  = (__dom.queryIds(box.__nid, 'body .tag') || []).length;
        const cssAnc  = __csimCssSelectAll(box, 'body .tag').length;
        return [natBare, cssBare, natAnc, cssAnc].join(',');
      })();
    JS
    # .tag still found within box (1,1); no phantom body ancestor (0,0) on either engine.
    expect(result).to eq('1,1,0,0')
  end

  # Review F1/F4: a malformed delta (the parent listed as its own child, or a duplicate) is
  # sanitized, not installed — no self-cycle (which would hang the matcher), no double-listing.
  it 'sanitizes a self / duplicate child in the delta' do
    result = session.evaluate_script(<<~JS)
      (function () {
        const list = document.querySelector('.list');
        const items = __csimCssSelectAll(list, '.item').map(e => e.__nid);
        // Feed a hostile delta: the list itself + a duplicated first item + the real items.
        __dom.syncChildren(list.__nid, [list.__nid, items[0], items[0]].concat(items));
        // Must terminate (no cycle) and expose each item exactly once, list never its own child.
        const kids = (__dom.queryIds(__docRoot, '.list > *') || []).length;
        const selfChild = (__dom.queryIds(list.__nid, '.list') || []).length;   // list under itself?
        return kids + ',' + selfChild;
      })();
    JS
    # 3 distinct item children, and .list does not contain itself.
    expect(result).to eq('3,0')
  end
end
