# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# FontFace and FontFaceSet, generated from their IDL — the editor's draft's sizeAdjust beside @webref/idl's members, the
# set a setlike<FontFace>. The figures are headless Chrome's, but where Web IDL decides: a setlike's iterators are the
# backing set's own ("[object Set Iterator]"; Chrome names them "FontFaceSet Iterator").
RSpec.describe 'FontFace bindings' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const f = new FontFace('A', 'url(x)', {style: 'italic'});
        const q = new FontFace('Q', 'url(x)'), s = document.fonts;
        const ops = [s.has(q), s.add(q) === s, s.has(q), s.size >= 1, s.delete(q), s.has(q), s.delete(q)];
        const r = new FontFace('R', 'url(x)');
        s.add(r);
        const each = [];
        s.forEach(function (v, k, set) { each.push([v === r, k === r, set === s, Number(this)]); }, 7);
        const entry = [...s.entries()][0];
        const it = [Object.prototype.toString.call(s.values()), entry[0] === entry[1]];
        s.clear();
        return [
          error(() => new FontFace()),
          error(() => new FontFace('a')),
          new FontFace('a', {}).status,
          [f.family, f.style, f.weight, f.display, f.sizeAdjust, f.status, Object.keys(f)],
          error(() => { f.ascentOverride = 'bad'; }),
          error(() => new FontFaceSet()),
          ops,
          each,
          it,
          error(() => s.add({})),
          s.check('10px foo'),
          error(() => s.check('foo')),
          [s.status, s.ready === s.ready]
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'FontFace': 2 arguments required, but only 0 present.",
      "TypeError: Failed to construct 'FontFace': 2 arguments required, but only 1 present.",
      'error',
      ['A', 'italic', 'normal', 'auto', '100%', 'unloaded', []],
      "SyntaxError: Failed to set the 'ascentOverride' property on 'FontFace': Failed to set 'bad' as a property value.",
      "TypeError: Failed to construct 'FontFaceSet': Illegal constructor",
      [false, true, true, true, true, false, false],
      [[true, true, true, 7]],
      ['[object Set Iterator]', true],
      "TypeError: Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.",
      true,
      "SyntaxError: Failed to execute 'check' on 'FontFaceSet': Could not resolve 'foo' as a font.",
      ['loaded', true]
    ])
    expect(session.evaluate_async_script("document.fonts.load('foo').then(() => 'none', (e) => e.name + ': ' + e.message).then(arguments[0])")).to eq(
      "SyntaxError: Could not resolve 'foo' as a font."
    )
  end

  # A promise-typed attribute's getter rejects rather than throws (Web IDL; Chrome); `has` converts its argument; a
  # src that does not parse errors the face in Chrome's words; a rule whose src names no usable source is no face of
  # the set (Chrome).
  it 'converts and rejects as Web IDL says' do
    session.execute_script(<<~JS)
      const style = document.createElement('style');
      style.textContent = '@font-face { font-family: Eot; src: url(x.eot) format("embedded-opentype"); }';
      document.head.append(style);
    JS
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const loaded = Object.getOwnPropertyDescriptor(FontFace.prototype, 'loaded').get.call({});
        loaded.catch(() => {});
        return [
          Object.prototype.toString.call(loaded),
          error(() => document.fonts.has({})),
          error(() => document.fonts.has()),
          [...document.fonts].some((f) => f.family === 'Eot')
        ];
      })()
    JS
    expect(got).to eq([
      '[object Promise]',
      "TypeError: Failed to execute 'has' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.",
      "TypeError: Failed to execute 'has' on 'FontFaceSet': 1 argument required, but only 0 present.",
      false
    ])
    expect(session.evaluate_async_script("new FontFace('a', 'garbage').loaded.then(() => 'none', (e) => e.name + ': ' + e.message).then(arguments[0])")).to eq(
      "SyntaxError: The source provided ('garbage') could not be parsed as a value list."
    )
  end

  # A frame's set answers for the frame, whichever realm's method is called (Chrome): its CSS-connected faces, the same
  # objects each time.
  it "answers for a frame's set from another realm" do
    session.execute_script(<<~JS)
      const frame = document.createElement('iframe');
      frame.srcdoc = '<style>@font-face { font-family: FrA; src: url(/a.ttf); }</style><p style="font-family: FrA">x</p>';
      document.body.append(frame);
    JS
    sleep 0.1
    got = session.evaluate_script(<<~JS)
      (() => {
        const fonts = frames[0].document.fonts;
        const face = [...fonts][0];
        return [
          FontFaceSet.prototype.has.call(fonts, face),
          [...FontFaceSet.prototype.values.call(fonts)].length,
          [...fonts][0] === face
        ];
      })()
    JS
    expect(got).to eq([true, 1, true])
  end
end
