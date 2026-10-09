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
    expect(out).to eq(['print', true, nil, 'NotAllowedError', 2, -1, 'i { color: green; }', 2, 'b', 'screen', 'SyntaxError', 1])
  end
end
