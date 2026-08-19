# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Where a scroll-into-view leaves the page — the driver's own click included.
#
# The driver stands in for Cuprite / Ferrum and Playwright, and both of those scroll for a click
# through CDP's `DOM.scrollIntoViewIfNeeded`, which is Blink's `CenterIfNeeded`: a box already
# fully shown is left alone, and any other box is CENTRED. Scrolling the minimum instead — the
# `nearest` alignment Selenium's element-click uses — left an Avo tab's lazy `<turbo-frame>` 24px
# below the fold, so Turbo declined to load it and the pagination the spec waited for never
# rendered.
#
# Every figure below is Chrome 151's, measured on this page at a 937-tall viewport.
RSpec.describe 'scroll into view' do
  VIEWPORT = [1400, 937].freeze

  # A 34px target 2000px down, with 2000px after it.
  def target_session
    html = <<~HTML
      <!doctype html><html><body style="margin:0">
        <div style="height:2000px"></div>
        <div id="t" style="height:34px">target</div>
        <div style="height:2000px"></div>
      </body></html>
    HTML
    session_with(html)
  end

  def session_with(html)
    Capybara.register_driver(:sim_scroll) {|app| Capybara::Simulated::Driver.new(app, viewport: VIEWPORT) }
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }, mode: :sim_scroll)
    s.visit '/'
    s
  end

  def scroll_after(session, script)
    session.evaluate_script("(() => { #{script}; return window.scrollY; })()")
  end

  # Out of view in either direction lands at the same place: the centre.
  # 2000 - (937 - 34) / 2 = 1548.5, which Blink rounds to a whole pixel.
  it 'centres a target that is out of view' do
    s = target_session
    from_above = scroll_after(s, "window.scrollTo(0, 0); document.getElementById('t').scrollIntoViewIfNeeded()")
    from_below = scroll_after(s, "window.scrollTo(0, 3500); document.getElementById('t').scrollIntoViewIfNeeded()")
    expect([from_above, from_below]).to eq([1549, 1549])
  end

  # …but a target only CLIPPED by an edge moves the MINIMUM to its nearest edge, not to the centre.
  # This is Blink's third branch (`kClosestEdge` for a partially visible rect), and the one that
  # keeps a click from jumping the page when what it aims at is nearly on screen already: the
  # target's top 10px are cut off at 2010, and Chrome lands at 2000 rather than the centre's 1549.
  it 'moves a partly visible target the minimum' do
    s = target_session
    expect(scroll_after(s, "window.scrollTo(0, 2010); document.getElementById('t').scrollIntoViewIfNeeded()"))
      .to eq(2000)
  end

  # The same branch for a box TALLER than the viewport that is partly showing: a 1000px panel
  # starting 100px down lands at 100 (its top edge), where centring would say 267.
  it 'moves a partly visible panel to its nearest edge, not its centre' do
    s = session_with(<<~HTML)
      <!doctype html><html><body style="margin:0">
        <div style="height:100px"></div><div id="t" style="height:1000px">panel</div>
      </body></html>
    HTML
    expect(scroll_after(s, "window.scrollTo(0, 0); document.getElementById('t').scrollIntoViewIfNeeded()"))
      .to eq(100)
  end

  # The one no-op case: already fully shown.
  it 'leaves a target that is already fully shown' do
    s = target_session
    expect(scroll_after(s, "window.scrollTo(0, 1900); document.getElementById('t').scrollIntoViewIfNeeded()"))
      .to eq(1900)
  end

  # A box TALLER than the viewport and entirely out of view is centred — which puts the viewport in
  # its middle — and one the viewport already sits inside moves nothing.
  it 'handles a target taller than the viewport' do
    s = session_with(<<~HTML)
      <!doctype html><html><body style="margin:0">
        <div style="height:2000px"></div>
        <div id="t" style="height:1500px">tall</div>
        <div style="height:2000px"></div>
      </body></html>
    HTML
    outside = scroll_after(s, "window.scrollTo(0, 0); document.getElementById('t').scrollIntoViewIfNeeded()")
    inside  = scroll_after(s, "window.scrollTo(0, 2200); document.getElementById('t').scrollIntoViewIfNeeded()")
    expect([outside, inside]).to eq([2282, 2200])   # 2000 - (937 - 1500) / 2, then no-op
  end

  # `scrollIntoView` is the OTHER algorithm and keeps its own alignment: `start` aligns the top,
  # whether or not the box was already showing. The two used to be aliases.
  it 'keeps scrollIntoView aligning to the top' do
    s = target_session
    expect(scroll_after(s, "window.scrollTo(0, 0); document.getElementById('t').scrollIntoView()")).to eq(2000)
  end

  # The driver's own click rides on the same rule — this is what puts a below-the-fold target's
  # surroundings on screen for whatever the test looks at next.
  it 'centres the target of a click that has to scroll' do
    s = target_session
    s.find('#t').click
    expect(s.evaluate_script('window.scrollY')).to eq(1549)
  end
end
