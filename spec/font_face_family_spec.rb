# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A FontFace's family is parsed as the `@font-face` rule's `font-family` descriptor (CSS Font Loading §2.1 step 1, the
# `family` setter): one `<family-name>` — a string, or identifiers, none of them a CSS-wide keyword and no lone one a
# generic family — its serialization what `family` reads; a value that is none errors the face (`status` "error", its
# family the empty string), and the setter throws a SyntaxError. (Chrome and Firefox keep the string as a literal name
# — csswg-drafts#6236 — where the current draft says to parse it.)
RSpec.describe 'FontFace family' do
  def session
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] }).tap {|s| s.visit '/' }
  end

  it 'reads the descriptor serialized, and errors a face whose family is none' do
    got = session.evaluate_script(<<~'JS')
      ['My  Font', '"My Font"', "c\\64 e", 'Bob\'', 'serif', '"serif"', 'a, b', 'inherit', ''].map((f) => {
        const face = new FontFace(f, 'local(x)');
        return [face.family, face.status];
      })
    JS
    expect(got).to eq([
      ['My Font', 'unloaded'], ['"My Font"', 'unloaded'], ['cde', 'unloaded'], ['', 'error'], ['', 'error'],
      ['"serif"', 'unloaded'], ['', 'error'], ['', 'error'], ['', 'error']
    ])
  end

  it 'throws a SyntaxError for a family set that is none, and keeps the one it had' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const face = new FontFace('A', 'local(x)');
        let error = null;
        try { face.family = 'a, b'; } catch (e) { error = e.name; }
        face.family = "'B c'";
        return [error, face.family];
      })()
    JS
    expect(got).to eq(['SyntaxError', '"B c"'])
  end
end
