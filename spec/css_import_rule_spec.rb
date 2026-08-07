# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# CSSOM `@import` rule modelling (`CSSImportRule.styleSheet` fetched + linked lazily), and the
# cascade dropping a removed `<style>`'s rules on the next synchronous style read.
RSpec.describe 'CSSImportRule + stylesheet removal' do
  let(:imported_css) { ':root { --imported: 1 }' }

  let(:app) {
    css = imported_css
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/imported.css' then [200, {'content-type' => 'text/css'}, [css]]
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!DOCTYPE html><html><head><style id="style">
              @import url("imported.css") supports((display: flex) or (display: block));
              :root { background-color: lime }
            </style></head><body></body></html>
          HTML
        else
          [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  it 'exposes the imported CSSStyleSheet (non-constructed, linked) and parses supports/href' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const sheet = document.styleSheets[0];
      const rule  = sheet.cssRules[0];
      const child = rule.styleSheet;
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      JSON.stringify({
        isImport:      rule instanceof CSSImportRule,
        href:          rule.href,
        supports:      rule.supportsText,
        childIsSheet:  child instanceof CSSStyleSheet,
        childParent:   child && child.parentStyleSheet === sheet,
        childOwner:    child && child.ownerRule === rule,
        childReplace:  err(() => child.replaceSync('.x{}')),   // NotAllowedError (non-constructed)
      });
    JS
    r = JSON.parse(out)
    expect(r['isImport']).to be true
    expect(r['href']).to eq('imported.css')
    expect(r['supports']).to eq('(display: flex) or (display: block)')
    expect(r['childIsSheet']).to be true
    expect(r['childParent']).to be true
    expect(r['childOwner']).to be true
    expect(r['childReplace']).to eq('NotAllowedError')
  end

  it "drops a removed <style> element's rules on the next synchronous getComputedStyle read" do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const before = getComputedStyle(document.documentElement).backgroundColor;
      document.getElementById('style').remove();
      const after = getComputedStyle(document.documentElement).backgroundColor;
      JSON.stringify({ before, after });
    JS
    r = JSON.parse(out)
    expect(r['before']).to eq('rgb(0, 255, 0)')    # lime, from the <style> rule
    expect(r['after']).to eq('rgba(0, 0, 0, 0)')   # removed → the initial (transparent)
  end
end
