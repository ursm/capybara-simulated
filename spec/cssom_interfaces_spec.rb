# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# Small CSSOM interface-completeness fixes: CSSStyleDeclaration is iterable, CSSMediaRule.media
# has the [PutForwards=mediaText] setter, and an @keyframes name that is a CSS-wide keyword /
# `none` serializes as a quoted string.
RSpec.describe 'CSSOM interface completeness' do
  let(:app) {
    Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }
        <!DOCTYPE html><html><head><style>
          #a { color: red; font-size: 10px }
          @media screen, print {}
          @keyframes spin {}
          @page {}
        </style></head><body><div id="a"></div></body></html>
      HTML
    }.to_app
  }

  before { Capybara.app = app }

  it 'exposes the CSSOM interface surface (iterator / media setter / keyframes-name quoting)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const sheet  = document.styleSheets[0];
      const media  = sheet.cssRules[1];
      const frames = sheet.cssRules[2];
      const el     = document.getElementById('a');
      el.style.cssText = 'color: red; font-size: 10px';   // inline decl to iterate
      media.media = 'speech';                             // [PutForwards=mediaText]
      frames.name = 'initial';                            // CSS-wide keyword → quoted
      JSON.stringify({
        declHasIterator: Symbol.iterator in CSSStyleDeclaration.prototype,
        iteratedProps:   Array.from(el.style).sort(),
        mediaText:       media.media.mediaText,
        keyframesCss:    frames.cssText.replace(/\\s/g, ''),
      });
    JS
    r = JSON.parse(out)
    expect(r['declHasIterator']).to be true
    expect(r['iteratedProps']).to eq(['color', 'font-size'])
    expect(r['mediaText']).to eq('speech')
    expect(r['keyframesCss']).to eq('@keyframes"initial"{}')
  end

  it 'accepts multiple @page pseudo-pages, preserving order and repeats verbatim' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const page = document.styleSheets[0].cssRules[3];
      const set = (v) => { page.selectorText = v; return { sel: page.selectorText, css: page.cssText }; };
      JSON.stringify({
        one:  set('named:first'),
        two:  set('named:first:first'),          // repeat kept
        four: set('named:first:left:right:first'),
        bad:  set('named:bogus'),                // invalid pseudo → unchanged
      });
    JS
    r = JSON.parse(out)
    expect(r['one']).to eq('sel' => 'named:first', 'css' => '@page named:first { }')
    expect(r['two']).to eq('sel' => 'named:first:first', 'css' => '@page named:first:first { }')
    expect(r['four']).to eq('sel' => 'named:first:left:right:first', 'css' => '@page named:first:left:right:first { }')
    expect(r['bad']['sel']).to eq('named:first:left:right:first')   # invalid selector left the rule unchanged
  end
end
