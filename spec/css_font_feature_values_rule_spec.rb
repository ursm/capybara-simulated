# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# CSSOM `@font-feature-values` (css-fonts-4): CSSFontFeatureValuesRule exposes `type === 14`,
# a settable `fontFamily`, and one CSSFontFeatureValuesMap per feature at-rule (@annotation /
# @styleset / @stylistic / @swash / @ornaments / @character-variant), each a maplike of
# `<name>` → sequence of numbers.
RSpec.describe 'CSSFontFeatureValuesRule' do
  let(:app) {
    Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style></style></head><body></body></html>']] }
    }.to_app
  }

  before { Capybara.app = app }

  it 'parses the rule + maps and supports set/delete/clear on the feature maps' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const sheet = document.styleSheets[0];
      sheet.insertRule(`@font-feature-values fam {
        @annotation { the_first: 6; }
        @styleset { yo: 7; di: 10 9 4 5; }
        @character-variant { cv: 3 4; }
      }`);
      const rule = sheet.cssRules[0];
      const before = {
        type:        rule.type,
        isRule:      rule instanceof CSSFontFeatureValuesRule,
        fontFamily:  rule.fontFamily,
        annotation:  rule.annotation.get('the_first'),
        di:          rule.styleset.get('di'),
        cv:          rule.characterVariant.get('cv'),
        stylistic0:  rule.stylistic.size,          // an absent feature → empty map
        hasYo:       rule.styleset.has('yo'),
      };
      rule.fontFamily = 'renamed';
      rule.styleset.set('di', 43);                 // bare number → single-element sequence
      rule.styleset.set('yo', [1, 2]);             // sequence stored as-is
      rule.annotation.delete('the_first');
      rule.characterVariant.clear();
      const after = {
        fontFamily:  sheet.cssRules[0].fontFamily,
        diSingle:    sheet.cssRules[0].styleset.get('di'),
        yoSeq:       sheet.cssRules[0].styleset.get('yo'),
        stylesetSize: sheet.cssRules[0].styleset.size,
        annotationSize: sheet.cssRules[0].annotation.size,
        cvSize:      sheet.cssRules[0].characterVariant.size,
      };
      JSON.stringify({ before, after });
    JS
    r = JSON.parse(out)
    expect(r['before']).to eq(
      'type'       => 14,
      'isRule'     => true,
      'fontFamily' => 'fam',
      'annotation' => [6],
      'di'         => [10, 9, 4, 5],
      'cv'         => [3, 4],
      'stylistic0' => 0,
      'hasYo'      => true
    )
    expect(r['after']).to eq(
      'fontFamily'     => 'renamed',
      'diSingle'       => [43],
      'yoSeq'          => [1, 2],
      'stylesetSize'   => 2,     # yo + di still present
      'annotationSize' => 0,     # the_first deleted
      'cvSize'         => 0      # cleared
    )
  end
end
