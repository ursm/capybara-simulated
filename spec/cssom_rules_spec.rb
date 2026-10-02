# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a CSSOM rule says is what the style engine reads of it (cssom_rule.rs): a style rule's selector is the list the
# engine parses and serializes, an `@namespace` rule's prefix the identifier it reads, an `@counter-style` rule's
# descriptors the ones it keeps. Every expectation is Chrome 151's on the same markup, unless it says otherwise.
RSpec.describe 'CSSOM rules' do
  def page(css)
    html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>#{css}</style></head><body></body></html>"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  # A selector the engine does not parse leaves the rule as it was; one it does is written as it serializes it — the
  # legacy pseudo-elements with two colons, an An+B canonical, a prefix of the sheet's `@namespace` (escaped as it was
  # declared) kept, an undeclared one refused.
  it 'takes a selector as the engine parses it' do
    got = page('@namespace ns\:odd url(ns); .a { color: red }').evaluate_script(<<~JS)
      (() => {
        const rule = document.styleSheets[0].cssRules[1];
        return [':first-line', 'p::FIRST-LETTER', ':gibberish', 'ns\\\\:odd|p', 'x|p', ':nth-child( odd )'].map((s) => {
          rule.selectorText = s;
          const text = rule.selectorText;
          rule.selectorText = '.a';
          return text;
        });
      })()
    JS
    expect(got).to eq(['::first-line', 'p::first-letter', '.a', 'ns\:odd|p', '.a', ':nth-child(2n+1)'])
  end

  it 'reads an @namespace prefix as an identifier' do
    got = page('@namespace ns\:odd url(ns);').evaluate_script(<<~JS)
      (() => { const rule = document.styleSheets[0].cssRules[0]; return [rule.prefix, rule.namespaceURI, rule.cssText]; })()
    JS
    expect(got).to eq(['ns:odd', 'ns', '@namespace ns\:odd url("ns");'])
  end

  # Each descriptor is an attribute, and `cssText` holds them all (Chrome orders them `system; symbols; suffix`, the
  # engine as Gecko does — the order is not specified). A write the engine refuses changes nothing: a value that does
  # not parse, another KIND of system (even one the symbols would allow), a name no counter style can have.
  it "keeps an @counter-style rule's descriptors, and refuses the writes the engine refuses" do
    got = page('@counter-style foo { system: cyclic; symbols: "*"; suffix: " " }').evaluate_script(<<~JS)
      (() => {
        const rule = document.styleSheets[0].cssRules[0];
        const out = [rule.cssText, rule.system, rule.symbols, rule.suffix, rule.prefix];
        rule.system = 'bogus';
        rule.symbols = '"a" "b"';
        rule.system = 'numeric';
        rule.name = 'none';
        rule.name = 'bar';
        return out.concat([rule.system, rule.symbols, rule.name, rule.cssText]);
      })()
    JS
    expect(got).to eq([
      '@counter-style foo { system: cyclic; suffix: " "; symbols: "*"; }', 'cyclic', '"*"', '" "', '',
      'cyclic', '"a" "b"', 'bar', '@counter-style bar { system: cyclic; suffix: " "; symbols: "a" "b"; }'
    ])
  end

  # A `::-webkit-` pseudo-element no specification defines is valid and matches nothing (Selectors 4), so its rule
  # stays and the rest of its list applies; `:-webkit-autofill` is `:autofill`'s legacy alias, and serializes as it
  # (Firefox; Chrome keeps the alias). A selector the engine does not parse makes no rule at all — Chrome drops the
  # `::-moz-selection` one, and `insertRule` refuses it.
  it 'keeps a -webkit- pseudo-element rule and drops a selector the engine refuses' do
    css = '::-webkit-scrollbar { width: 1px } input:-webkit-autofill { color: red } ::-moz-selection { color: blue } ' \
          '::-webkit-scrollbar, b { color: green }'
    got = page(css).evaluate_script(<<~JS)
      (() => {
        const sheet = document.styleSheets[0], out = [...sheet.cssRules].map((r) => r.selectorText);
        try { sheet.insertRule('::-moz-selection { color: red }', 0); out.push('inserted'); } catch (e) { out.push(e.name); }
        const b = document.body.appendChild(document.createElement('b'));
        return out.concat(getComputedStyle(b).color);
      })()
    JS
    expect(got).to eq(['::-webkit-scrollbar', 'input:autofill', '::-webkit-scrollbar, b', 'SyntaxError', 'rgb(0, 128, 0)'])
  end

  # `::highlight()` is a pseudo-element the engine parses (never styled here), so a rule naming one is inserted.
  it 'inserts a ::highlight() rule' do
    got = page('').evaluate_script(<<~JS)
      (() => { const sheet = document.styleSheets[0]; sheet.insertRule('.p::highlight(Mine) { color: red }'); return sheet.cssRules[0].selectorText; })()
    JS
    expect(got).to eq('.p::highlight(Mine)')
  end

  # A rule is the engine's own rule: an edit through it — its declarations (kept as written, not as their serialization
  # rounds them, as an element's are), its selector — restyles at once, an empty `<style>`'s sheet included, and a
  # deleted rule is detached but still reads. (Chrome: 10px, 123.453px, 123.457px, then the selector, then detached.)
  it 'edits the engine rule in place' do
    got = page('').evaluate_script(<<~JS)
      (() => {
        const sheet = document.styleSheets[0], out = [];
        const d = document.body.appendChild(document.createElement('div'));
        d.style.display = 'inline-block';
        sheet.insertRule('div { width: 10px }');
        const rule = sheet.cssRules[0];
        out.push(getComputedStyle(d).width);
        rule.style.setProperty('width', '123.4567891px');
        out.push(getComputedStyle(d).width, rule.style.width);
        rule.selectorText = '#nope';
        out.push(getComputedStyle(d).width);
        rule.selectorText = 'div';
        out.push(sheet.cssRules[0] === rule);
        sheet.deleteRule(0);
        return out.concat(rule.parentStyleSheet, rule.cssText);
      })()
    JS
    expect(got).to eq(['10px', '123.4568px', '123.457px', '0px', true, nil, 'div { width: 123.457px; }'])
  end

  # Every rule the engine parses is in the rule list as its interface (Chrome: the same four).
  it 'lists the at-rules the engine parses' do
    css = '@layer a, b; @container (min-width: 1px) { p { color: red } } ' \
          '@property --x { syntax: "<length>"; inherits: false; initial-value: 0px } @page :first { margin: 1in }'
    got = page(css).evaluate_script('[...document.styleSheets[0].cssRules].map((r) => r.constructor.name)')
    expect(got).to eq(%w[CSSLayerStatementRule CSSContainerRule CSSPropertyRule CSSPageRule])
  end

  # Sheets of one text share the engine's parse until CSSOM reaches one, which then takes its own copy: an edit of one
  # is its alone — the other still reads and applies what it was written with (Chrome: the same).
  it 'keeps an edit of one of two sheets of the same text its alone' do
    got = page('div { width: 10px }</style><style>div { width: 10px }').evaluate_script(<<~JS)
      (() => {
        const [a, b] = document.styleSheets;
        const d = document.body.appendChild(document.createElement('div'));
        d.style.display = 'inline-block';
        a.cssRules[0].style.width = '20px';
        const one = [a.cssRules[0].cssText, b.cssRules[0].cssText, getComputedStyle(d).width];
        b.cssRules[0].style.width = '30px';
        return one.concat(a.cssRules[0].cssText, getComputedStyle(d).width);
      })()
    JS
    expect(got).to eq(['div { width: 20px; }', 'div { width: 10px; }', '10px', 'div { width: 20px; }', '30px'])
  end

  # A `<style>` obtains a new sheet whenever HTML updates its block — its `type` switched away and back, the element
  # removed and inserted again, a child added (an empty one too) — so a script's edit of the one before is gone and the
  # one before has no owner; and `@charset` is no rule `insertRule` can insert. (Chrome: the same, each value.)
  it 'makes a new sheet each time the style block is updated' do
    got = page('').evaluate_script(<<~JS)
      (() => {
        const out = [], r = document.body.appendChild(document.createElement('p'));
        const s = document.createElement('style');
        s.textContent = 'p { color: rgb(1, 0, 0) }';
        document.head.appendChild(s);
        s.sheet.cssRules[0].style.color = 'rgb(2, 0, 0)';
        s.type = 'text/plain';
        s.type = 'text/css';
        out.push(s.sheet.cssRules[0].cssText, getComputedStyle(r).color);
        s.sheet.cssRules[0].style.color = 'rgb(3, 0, 0)';
        s.remove();
        document.head.appendChild(s);
        out.push(getComputedStyle(r).color);
        const old = s.sheet;
        s.appendChild(document.createTextNode(''));
        out.push(s.sheet === old, old.ownerNode);
        try { s.sheet.insertRule('@charset "utf-8";', 0); } catch (e) { out.push(e.name); }
        return out;
      })()
    JS
    expect(got).to eq(['p { color: rgb(1, 0, 0); }', 'rgb(1, 0, 0)', 'rgb(1, 0, 0)', false, nil, 'SyntaxError'])
  end

  # …at once, for the cascade too: a `<style>` moved with its parent applies its new sheet, one re-inserted after its
  # sheet was disabled is enabled (a new sheet), and the sheet a script still holds after a text change is the old one
  # — no owner, its own rules. (Chrome: the same, each value.)
  it 'applies a renewed sheet at once and leaves the old one its rules' do
    got = page('').evaluate_script(<<~JS)
      (() => {
        const out = [];
        const wrap = document.body.appendChild(document.createElement('div'));
        const s1 = wrap.appendChild(document.createElement('style'));
        s1.textContent = '.r { color: rgb(3, 0, 0) }';
        const r = document.body.appendChild(document.createElement('p'));
        r.className = 'r';
        s1.sheet.cssRules[0].style.color = 'rgb(5, 0, 0)';
        document.body.appendChild(wrap);
        out.push(getComputedStyle(r).color);
        const s2 = document.head.appendChild(document.createElement('style'));
        s2.textContent = '.q { color: rgb(4, 0, 0) }';
        const q = document.body.appendChild(document.createElement('p'));
        q.className = 'q';
        s2.sheet.disabled = true;
        s2.remove();
        document.head.appendChild(s2);
        out.push(s2.sheet.disabled, getComputedStyle(q).color);
        const old = s2.sheet;
        s2.textContent = '.q { color: rgb(6, 0, 0) } .z { }';
        return out.concat(old.ownerNode, old.cssRules.length, s2.sheet.cssRules.length, getComputedStyle(q).color);
      })()
    JS
    expect(got).to eq(['rgb(3, 0, 0)', false, 'rgb(4, 0, 0)', nil, 1, 2, 'rgb(6, 0, 0)'])
  end
end
