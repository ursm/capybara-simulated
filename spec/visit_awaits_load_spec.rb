# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A visit returns once its document has loaded, as a browser's driver waits for `load` (browser.rb
# `await_document_load`): a style sheet whose server takes its time — the parser's, one a DOMContentLoaded listener
# inserts, one an `@import` tree holds, a `<style>`'s import — is applied by then, and so is a slow `async` script run; a
# frame's, however deep, as HTML's iframe delays its document's load by its content's.
RSpec.describe 'a visit and its document load' do
  pages = {
    '/parser'   => '<link rel=stylesheet href=/h.css><p class=x>x</p>',
    '/inserted' => '<p class=x>x</p><script>addEventListener("DOMContentLoaded", () => { const l = document.createElement("link"); ' \
                   'l.rel = "stylesheet"; l.href = "/h.css"; document.head.append(l) })</script>',
    '/import'   => '<link rel=stylesheet href=/i.css><p class=x>x</p>',
    '/style'    => '<style>@import url(/h.css);</style><p class=x>x</p>',
    '/async'    => '<script async src=/a.js></script><p class=x>x</p>',
    '/frame'    => '<iframe src=/f-sheet></iframe>',
    '/framejs'  => '<iframe src=/f-async></iframe>',
    '/nested'   => '<iframe src=/f-frame></iframe>',
    '/f-sheet'  => '<link rel=stylesheet href=/h.css?400><p class=x>x</p>',
    '/f-async'  => '<script async src=/a.js?400></script>',
    '/f-frame'  => '<iframe src=/f-sheet></iframe>'
  }

  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/h.css'
        sleep((env['QUERY_STRING'].to_i.nonzero? || 50) / 1000.0)
        [200, {'content-type' => 'text/css'}, ['.x { display: none }']]
      when '/i.css' then [200, {'content-type' => 'text/css'}, ['@import url(/h.css);']]
      when '/a.js'
        sleep((env['QUERY_STRING'].to_i.nonzero? || 50) / 1000.0)
        [200, {'content-type' => 'text/javascript'}, ['window.ran = true']]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>t</title>#{pages.fetch(env['PATH_INFO'])}"]]
      end
    })
  }

  %w[/parser /inserted /import /style].each do |path|
    it "has applied the sheet of #{path} as it returns" do
      session.visit path
      expect(session.evaluate_script('document.readyState')).to eq('complete')
      expect(session.find('.x', visible: :all).visible?).to be(false)
    end
  end

  it "has applied a frame's sheet as it returns" do
    session.visit '/frame'
    expect(session.evaluate_script('document.readyState')).to eq('complete')
    session.within_frame { expect(session.find('.x', visible: :all).visible?).to be(false) }
  end

  it "has applied a nested frame's sheet as it returns" do
    session.visit '/nested'
    expect(session.evaluate_script('document.readyState')).to eq('complete')
    session.within_frame { session.within_frame { expect(session.find('.x', visible: :all).visible?).to be(false) } }
  end

  it "has run a frame's slow async script as it returns" do
    session.visit '/framejs'
    expect(session.evaluate_script('[document.readyState, frames[0].ran]')).to eq(['complete', true])
  end

  it 'has run a slow async script as it returns' do
    session.visit '/async'
    expect(session.evaluate_script('[document.readyState, window.ran]')).to eq(['complete', true])
  end
end
