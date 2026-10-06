# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# document.evaluate is xpath.rs over the arena. What the arena has to carry for it, and what the binding has to hand
# it, beyond what the domxpath WPT tree reaches.
RSpec.describe 'XPath' do
  def session_with(body)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html>#{body}"]] })
    s.visit '/'
    s
  end

  # The parser's elements of the page carry no owner document of their own (the getter falls back to `document`): the
  # evaluation is in an HTML document all the same, or no unprefixed name test matches an HTML element.
  it 'evaluates in an HTML document from an element the parser made' do
    s = session_with('<p><span>a</span><span>b</span></p>')
    got = s.evaluate_script(<<~'JS')
      document.evaluate('count(//span)', document.body, null, XPathResult.NUMBER_TYPE, null).numberValue
    JS
    expect(got).to eq(2)
    expect(s.find(:css, 'p').all(:xpath, '//SPAN').size).to eq(2)
  end

  it "answers name() with an element's prefix, and a processing instruction's target" do
    s = session_with('')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const doc = new DOMParser().parseFromString('<r xmlns:p="urn:p"><p:x/><?go now?></r>', 'application/xml');
        const str = (x) => doc.evaluate(x, doc, null, XPathResult.STRING_TYPE, null).stringValue;
        return [str('name(/r/*)'), str('local-name(/r/*)'), str('name(/r/processing-instruction())'), str("string(/r/processing-instruction('go'))")];
      })()
    JS
    expect(got).to eq(['p:x', 'x', 'go', 'now'])
  end

  it 'evaluates from an attribute, whose parent is its element' do
    s = session_with('<div id="d" title="t"></div>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const attr = document.getElementById('d').getAttributeNode('title');
        const r = document.evaluate('..', attr, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return [r.singleNodeValue.id, document.evaluate('string(.)', attr, null, XPathResult.STRING_TYPE, null).stringValue];
      })()
    JS
    expect(got).to eq(['d', 't'])
  end

  it 'finds an attribute node and hands back the Attr the element holds' do
    s = session_with('<div id="d" title="t"></div>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const el = document.getElementById('d');
        const r = document.evaluate('//@title', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue === el.getAttributeNode('title');
      })()
    JS
    expect(got).to be(true)
  end

  # Chrome-measured, every figure below but the one `id()` notes.
  it 'walks the sibling axes over text and comments, not only elements' do
    s = session_with('<p><b>x</b>tail<!--c--><i>y</i></p><dl><dt>Name</dt>: <dd>Bob</dd></dl>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const n = (x) => document.evaluate(x, document, null, XPathResult.NUMBER_TYPE, null).numberValue;
        const str = (x) => document.evaluate(x, document, null, XPathResult.STRING_TYPE, null).stringValue;
        return [
          n('count(//b/following-sibling::node())'),
          str('string(//b/following-sibling::text())'),
          n('count(//i/preceding-sibling::comment())'),
          str('name(//i/preceding-sibling::node()[1])'),
          str('string(//dt/following-sibling::text()[1])'),
          n('count(//b/following::text())')
        ];
      })()
    JS
    expect(got).to eq([3, 'tail', 1, '', ': ', 5])
  end

  it "takes a context node of another realm's wrapper" do
    s = session_with('<iframe srcdoc="<p>in</p>"></iframe>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const doc = document.querySelector('iframe').contentDocument;
        const moved = doc.createElement('span');
        document.body.appendChild(moved);
        return [
          document.evaluate('count(//p)', doc, null, XPathResult.NUMBER_TYPE, null).numberValue,
          document.evaluate('name(/*)', moved, null, XPathResult.STRING_TYPE, null).stringValue
        ];
      })()
    JS
    expect(got).to eq([1, 'HTML'])
  end

  it 'keeps a lone surrogate in a literal' do
    s = session_with('<p data-s="x"></p>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        document.querySelector('p').setAttribute('data-s', '\ud800');
        return [
          document.evaluate('"\ud800"', document, null, XPathResult.STRING_TYPE, null).stringValue === '\ud800',
          document.evaluate('count(//p[@data-s="\ud800"])', document, null, XPathResult.NUMBER_TYPE, null).numberValue
        ];
      })()
    JS
    expect(got).to eq([true, 1])
  end

  # id() searches the tree the context node is in — the REC's document is the data model's root node — so a detached
  # tree's own root is found (Firefox: 1; Chrome searches the node document instead, 0).
  it "finds the root of a detached tree by id(), and rounds a negative half to -0" do
    s = session_with('')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const root = document.createElement('div');
        root.id = 'droot';
        root.innerHTML = '<p><i></i></p>';
        const i = root.querySelector('i');
        return [
          document.evaluate('count(id("droot"))', i, null, XPathResult.NUMBER_TYPE, null).numberValue,
          document.evaluate('1 div round(-0.5)', document, null, XPathResult.NUMBER_TYPE, null).numberValue
        ];
      })()
    JS
    expect(got).to eq([1, -Float::INFINITY])
  end

  # An unprefixed test in an HTML document names the HTML namespace, ASCII-lowercased and then compared exactly (HTML
  # "Interactions with XPath and XSLT"): no no-namespace element, and no attribute set mixed-case by setAttributeNS.
  it 'matches no no-namespace element and no mixed-case attribute by an unprefixed test' do
    s = session_with('<div id="d"></div>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const d = document.getElementById('d');
        d.appendChild(document.createElementNS(null, 'Foo'));
        d.setAttributeNS(null, 'Data-Up', 'v');
        const n = (x) => document.evaluate(x, document, null, XPathResult.NUMBER_TYPE, null).numberValue;
        return [n('count(//Foo)'), n('count(//foo)'), n('count(//div[@Data-Up])'), n('count(//div[@data-up])'), n('count(//div/@data-up)')];
      })()
    JS
    expect(got).to eq([0, 0, 0, 0, 0])
  end

  it 'reports an unknown function at compile, a fragment context, and its arguments in order' do
    s = session_with('')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const order = [];
        const resolver = () => { order.push('resolver'); return 'urn:x'; };
        err(() => document.evaluate({ toString() { order.push('expr'); return '//p:a'; } }, 42, resolver));
        const names = [err(() => document.evaluate(Symbol('x'), document)), err(() => document.createExpression('//a\ud800'))];
        const r = document.evaluate('//*', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return [
          err(() => document.createExpression('foo()')),
          err(() => document.createExpression('concat("a")')),
          err(() => document.evaluate('.', document.createDocumentFragment(), null, 0, null)),
          order.join(','),
          err(() => r.snapshotItem()),
          String(r),
          names.join(',')
        ];
      })()
    JS
    expect(got).to eq(['SyntaxError', 'SyntaxError', 'NotSupportedError', 'expr', 'TypeError', '[object XPathResult]', 'TypeError,SyntaxError'])
  end

  # A result is any realm's to read, its iterator state told by the clock of the realm that made it — each realm counts
  # its own tree generations — and no own property of it shows its state.
  it "reads a frame's result through this realm's members" do
    s = session_with('<p>a<iframe srcdoc="<p>x<p>y"></iframe>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const fd = frames[0].document, r = fd.evaluate('//p', fd, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        const valid = Object.getOwnPropertyDescriptor(XPathResult.prototype, 'invalidIteratorState').get.call(r);
        return [valid, XPathResult.prototype.iterateNext.call(r).textContent, Reflect.ownKeys(r).filter((k) => typeof k === 'string'),
                (() => { try { return Object.create(XPathEvaluator.prototype).evaluate('1', document).numberValue; } catch (e) { return e.name; } })()];
      })()
    JS
    expect(got).to eq([false, 'x', [], 'TypeError'])
  end
end
