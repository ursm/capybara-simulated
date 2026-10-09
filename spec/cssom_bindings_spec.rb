# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The CSSOM's sheets, rules and lists, generated from their IDL: made by the platform alone (a constructed sheet aside),
# their state in slots, their arguments converted. A rule list, a style sheet list and a media list are legacy platform
# objects with indices — not arrays — and `document.styleSheets` is the same list each time, as live as the tree; an
# `@keyframes` rule has indices too, a feature values map is a maplike, and the members the other specs add — a media
# or supports rule's `matches`, a container rule's conditions, a palette's base and overrides — answer.
RSpec.describe 'CSSOM bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8">
        <style id="s">
          @media (min-width: 1px) { p { color: red } }
          @supports (display: grid) { p { color: blue } }
          @container card (min-width: 10px) { p { color: green } }
          @keyframes k { from { opacity: 0 } to { opacity: 1 } }
          @font-feature-values Foo { @styleset { nice: 1 2; } }
          @font-palette-values --p { font-family: Foo; base-palette: 1; override-colors: 0 red; }
        </style>
      HTML
    }
  }

  def run(session, script)
    session.execute_script(<<~JS)
      globalThis.__out = null;
      (async () => { #{script} })().then((v) => { globalThis.__out = v; }, (e) => { globalThis.__out = 'threw ' + e.name + ': ' + e.message; });
    JS
    session.evaluate_script('globalThis.__out')
  end

  it 'is what their IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const sheet = s.sheet, rules = sheet.cssRules;
      const [media, supports, container, keyframes, features, palette] = rules;
      const map = features.styleset;
      map.set('wow', 7);
      return [
        err(() => new CSSRule()), err(() => new CSSRuleList()), err(() => new MediaList()), err(() => new StyleSheet()),
        Array.isArray(rules), rules instanceof CSSRuleList, rules === sheet.cssRules, rules[0] === rules.item(0), rules.item(99),
        document.styleSheets === document.styleSheets, document.styleSheets[0] === sheet,
        Object.getPrototypeOf(CSSStyleSheet.prototype) === StyleSheet.prototype, CSSRule.STYLE_RULE, media.type,
        media.matches, supports.matches, [container.containerName, container.containerQuery, container.conditionText],
        Object.isFrozen(container.conditions), container.conditions === container.conditions,
        keyframes[1].keyText, keyframes.length, map.get('nice'), map.get('wow'), [...map.keys()], map.size,
        [palette.basePalette, palette.overrideColors],
        err(() => CSSStyleRule.prototype.selectorText), err(() => Object.getOwnPropertyDescriptor(CSSMediaRule.prototype, 'media').get.call(supports)),
        String(media.media), media.media[0], media.media.length
      ];
    JS
    expect(out).to eq([
      'TypeError', 'TypeError', 'TypeError', 'TypeError',
      false, true, true, true, nil, true, true, true, 1, 4,
      true, true, ['card', '(min-width: 10px)', 'card (min-width: 10px)'], true, true,
      '100%', 2, [1, 2], [7], %w[nice wow], 2, ['1', '0 red'],
      'TypeError', 'TypeError', '(min-width: 1px)', '(min-width: 1px)', 1
    ])
  end

  it 'makes and changes sheets through their IDL' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const sheet = new CSSStyleSheet({media: 'print', disabled: true});
      const out = [sheet.media.mediaText, sheet.disabled, sheet.href, err(() => s.sheet.replaceSync('p {}'))];
      sheet.replaceSync('a { color: red } b { color: blue }');
      out.push(sheet.cssRules.length, sheet.addRule('i', 'color: green'), sheet.cssRules[2].cssText);
      sheet.removeRule();
      out.push(sheet.cssRules.length, sheet.cssRules[0].selectorText);
      sheet.media = 'screen';
      out.push(sheet.media.mediaText, err(() => sheet.insertRule('not a rule')));
      const list = document.styleSheets, before = list.length;
      document.head.appendChild(document.createElement('style'));
      out.push(list.length - before);
      return out;
    JS
    # (A constructed sheet's location is its document's base URL, CSSOM's "create a constructed CSSStyleSheet" says;
    # Chrome and Firefox — measured — answer null.)
    expect(out).to eq(['print', true, 'http://www.example.com/', 'NotAllowedError', 2, -1, 'i { color: green; }', 2, 'b', 'screen', 'SyntaxError', 1])
  end

  # A declaration block is the interface of its kind: an element's, a style rule's and a computed style a
  # CSSStyleProperties with an attribute for every property; a page rule's and a font face's the descriptors interface
  # of theirs, with an attribute for each descriptor and none for any other property (Firefox alike).
  it 'makes each declaration the interface of its kind' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><style id="s">@page { margin: 1in } @font-face { font-family: x } p { float: left }</style><p id="p">']] })
    session.visit '/'
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const [page, face, rule] = s.sheet.cssRules;
      const cls = (o) => Object.prototype.toString.call(o);
      return [
        err(() => new CSSStyleDeclaration()), err(() => p.style.getPropertyValue()),
        cls(p.style), cls(getComputedStyle(p)), cls(rule.style), cls(page.style), cls(face.style),
        rule.style.cssFloat, page.style.marginTop, page.style['margin-top'], 'color' in page.style, page.style.color,
        face.style.fontFamily, 'fontFamily' in rule.style, rule.style instanceof CSSStyleDeclaration,
        Object.getPrototypeOf(CSSPageDescriptors.prototype) === CSSStyleDeclaration.prototype,
        err(() => Object.getOwnPropertyDescriptor(CSSStyleProperties.prototype, 'color').get.call(page.style))
      ];
    JS
    expect(out).to eq([
      'TypeError', 'TypeError',
      '[object CSSStyleProperties]', '[object CSSStyleProperties]', '[object CSSStyleProperties]',
      '[object CSSPageDescriptors]', '[object CSSFontFaceDescriptors]',
      'left', '1in', '1in', false, nil, 'x', true, true, true, 'TypeError'
    ])
  end

  # A member of this realm's binding acts on another realm's rule and sheet as that realm's own (an iframe's rules are
  # its own store's); `replace` makes a sheet of the text a task later, refusing modification until then; a grouping
  # rule a sheet no longer holds still edits its own list, and lets go of its rules; an `@import`'s media list is its
  # sheet's, the same object; and an empty initial value is one.
  it 'acts on each object in its own realm' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] })
      <!doctype html><meta charset="utf-8">
      <style id="s">@import url(data:text/css,p{}) print; a { color: red } b { color: red } @media all { i { color: red } }</style>
      <iframe id="f" srcdoc="<style>q { color: blue } u { color: blue } v { & a {} color: blue; }</style>"></iframe>
    HTML
    session.visit '/'
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      await new Promise((resolve) => (f.contentDocument.readyState === 'complete' ? resolve() : f.onload = resolve));
      const frameSheet = f.contentDocument.styleSheets[0], frameRule = frameSheet.cssRules[0];
      const selectorText = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'selectorText');
      const out = [selectorText.get.call(frameRule)];
      selectorText.set.call(frameRule, 'em');
      CSSStyleSheet.prototype.insertRule.call(frameSheet, 'ins { color: green }', 1);
      const nested = frameSheet.cssRules[3].cssRules[1];
      out.push(frameSheet.cssRules[0].selectorText, frameSheet.cssRules[1].selectorText, s.sheet.cssRules[1].selectorText,
        frameSheet.cssRules[1] instanceof f.contentWindow.CSSStyleRule,
        Object.getOwnPropertyDescriptor(CSSNestedDeclarations.prototype, 'style').get.call(nested).cssText);
      const sheet = new CSSStyleSheet(), pending = sheet.replace('x { color: red }');
      out.push(err(() => sheet.insertRule('y {}')), sheet.cssRules.length);
      await pending;
      out.push(sheet.cssRules.length, err(() => sheet.insertRule('y {}')));
      const media = s.sheet.cssRules[3], child = media.cssRules[0];
      s.sheet.deleteRule(3);
      media.insertRule('z { color: red }', 0);
      out.push(media.cssRules.length, child.parentStyleSheet);
      const imported = s.sheet.cssRules[0];
      out.push(imported.media === imported.styleSheet.media, imported.styleSheet.media.mediaText);
      sheet.replaceSync('@property --x { syntax: "*"; inherits: false; initial-value: ; }');
      out.push(sheet.cssRules[0].initialValue);
      return out;
    JS
    expect(out).to eq(['q', 'em', 'ins', 'a', true, 'color: blue;', 'NotAllowedError', 0, 1, 'none', 2, nil, true, 'print', ''])
  end
end
