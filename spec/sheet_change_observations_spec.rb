# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A change of what the cascade is made of — an adopted sheet, a constructed sheet's text — is one a rendering update's
# observations hear of, though no node changed: the engine asks them of the realm whose cascade it made stale
# (sheet_feed.rs `stale_cascade`), as a change of its tree asks them. A ResizeObserver whose box only a sheet resized
# heard nothing until an unrelated DOM write came.
RSpec.describe 'a style sheet change with no DOM change' do
  include PollUntil

  it "is observed at the next rendering update" do
    html = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <div id=box style="height: 10px">x</div>
      <script>
        window.__widths = [];
        new ResizeObserver((entries) => { for (const e of entries) window.__widths.push(Math.round(e.contentRect.width)); }).observe(box);
        window.__sheet = new CSSStyleSheet();
        __sheet.replaceSync('#box { width: 77px }');
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    last = -> { s.evaluate_script('window.__widths.at(-1)') }
    expect(poll_until { last.call }).to be > 77
    s.execute_script('document.adoptedStyleSheets = [__sheet]')
    expect(poll_until { last.call == 77 && last.call }).to eq(77)
    s.execute_script("__sheet.replaceSync('#box { width: 66px }')")
    expect(poll_until { last.call == 66 && last.call }).to eq(66)
    s.execute_script('document.adoptedStyleSheets = []')
    expect(poll_until { last.call > 77 && last.call }).to be > 77
  end
end
