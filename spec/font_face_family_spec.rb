# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A FontFace's family is parsed as the `@font-face` rule's `font-family` descriptor: one `<family-name>` — a string, or
# identifiers, none of them a CSS-wide keyword and no lone one a generic family — its serialization what `family`
# reads. A constructor's family that is none, or that does not write back as given, is a quoted string of itself
# (csswg-drafts#6236, resolved 2026-03-11, overturning the draft's SyntaxError; Chrome and Firefox both); the setter
# still throws a SyntaxError for one that is none.
RSpec.describe 'FontFace family' do
  def session
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] }).tap {|s| s.visit '/' }
  end

  it 'reads the descriptor serialized, and a family that is none as a quoted string of it' do
    got = session.evaluate_script(<<~'JS')
      ['My  Font', '"My Font"', "c\\64 e", 'Bob\'', 'serif', '"serif"', 'a, b', 'inherit', ''].map((f) => {
        const face = new FontFace(f, 'local(x)');
        return [face.family, face.status];
      })
    JS
    expect(got).to eq([
      ['"My  Font"', 'unloaded'], ['"My Font"', 'unloaded'], ['"c\\\\64 e"', 'unloaded'], ['"Bob\'"', 'unloaded'],
      ['"serif"', 'unloaded'], ['"serif"', 'unloaded'], ['"a, b"', 'unloaded'], ['"inherit"', 'unloaded'], ['""', 'unloaded']
    ])
    expect(session.evaluate_script("new FontFace('My Font', 'local(x)').family")).to eq('My Font')
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
