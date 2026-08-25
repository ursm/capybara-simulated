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

  # A scroll OFFSET lives only where a browser keeps one: on the document scroller, and on a
  # rendered scroll container. Everything else refuses the write and goes on reporting 0 — before
  # this the driver remembered whatever it was handed, on any element at all, so an
  # `overflow: clip` box reported an offset while its content (correctly) never moved.
  # Every figure is Chrome 137-measured on the same page.
  describe 'where a scroll offset can live' do
    def body_page(head, body)
      session_with("<!DOCTYPE html><html><head><style>body{margin:0}#{head}</style></head><body>#{body}</body></html>")
    end

    it 'keeps one only on a rendered scroll container, and on the document scroller' do
      body = <<~HTML
        <div id="vis"    style="width: 100px; height: 100px; overflow: visible"><div style="height: 400px"></div></div>
        <div id="clip"   style="width: 100px; height: 100px; overflow: clip"><div style="height: 400px"></div></div>
        <div id="hid"    style="width: 100px; height: 100px; overflow: hidden"><div style="height: 400px"></div></div>
        <div id="auto"   style="width: 100px; height: 100px; overflow: auto"><div style="height: 400px"></div></div>
        <div id="none"   style="display: none; overflow: auto"><div style="height: 400px"></div></div>
        <span id="inline" style="display: inline; overflow: auto"><div style="height: 400px"></div></span>
        <div style="height: 3000px"></div>
      HTML
      got = body_page('', body).evaluate_script(<<~JS)
        (() => {
          const out = ['vis', 'clip', 'hid', 'auto', 'none', 'inline'].map(id => {
            const e = document.getElementById(id);
            e.scrollTop = 100;
            return e.scrollTop;
          });
          document.body.scrollTop = 100;
          document.documentElement.scrollTop = 100;
          return out.concat([document.body.scrollTop, document.documentElement.scrollTop]);
        })()
      JS
      #      visible clip hidden auto  none  inline  body  root
      expect(got).to eq([0, 0, 100, 100, 0, 0, 0, 100])
    end

    it 'refuses scrollTo / scrollBy on the same elements' do
      body = '<div id="vis" style="width: 100px; height: 100px; overflow: visible"><div style="height: 400px"></div></div>' \
             '<div id="auto" style="width: 100px; height: 100px; overflow: auto"><div style="height: 400px"></div></div>'
      got = body_page('', body).evaluate_script(<<~JS)
        (() => {
          const vis = document.getElementById('vis'), auto = document.getElementById('auto');
          vis.scrollTo(0, 50); auto.scrollTo(0, 50);
          vis.scrollBy(0, 10); auto.scrollBy(0, 10);
          return [vis.scrollTop, auto.scrollTop];
        })()
      JS
      expect(got).to eq([0, 60])
    end

    it 'refuses the BODY when its overflow propagates, and accepts it when it does not' do
      # `body { overflow: auto }` propagates to the viewport (CSS Overflow 3.3), so the body is not
      # a scroller — but under `html { overflow: hidden }` the root took an overflow of its own and
      # the body becomes one in its own right. Chrome: 0, then 100.
      propagating = body_page('body{overflow:auto}', '<div style="height: 3000px"></div>')
      own         = body_page('html{overflow:hidden} body{overflow:auto;height:200px}', '<div style="height: 3000px"></div>')
      read = '(() => { document.body.scrollTop = 100; return document.body.scrollTop })()'
      expect([propagating.evaluate_script(read), own.evaluate_script(read)]).to eq([0, 100])
    end

    it 'keeps one on a LISTBOX select, not on a dropdown' do
      # Chrome computes `overflow-x: hidden; overflow-y: scroll` on a `size`d / `multiple` select
      # and honours `select.scrollTop = 40`; a dropdown select gets neither.
      body = '<select id="list" size="3"><option>1</option><option>2</option><option>3</option><option>4</option></select>' \
             '<select id="multi" multiple><option>1</option><option>2</option></select>' \
             '<select id="drop"><option>1</option></select>'
      got = body_page('', body).evaluate_script(<<~JS)
        (() => ['list', 'multi', 'drop'].map(id => {
          const e = document.getElementById(id);
          e.scrollTop = 40;
          return [e.scrollTop, getComputedStyle(e).overflowY];
        }))()
      JS
      expect(got).to eq([[40, 'scroll'], [40, 'scroll'], [0, 'visible']])
    end

    it 'takes a write to a box made scrollable in the same tick' do
      # The gate asks the CASCADE, not the layout pass's memo: that memo only advances when a pass
      # runs, so a panel that gains `overflow: auto` and restores its saved offset before anything
      # reads geometry would have been answered from before the change — and dropped.
      s = body_page('', '<div id="a" style="width: 100px; height: 100px"><div style="height: 400px"></div></div>')
      got = s.evaluate_script(<<~JS)
        (() => {
          const a = document.getElementById('a');
          a.getBoundingClientRect();               // stamp the pass memo while it is NOT scrollable
          a.style.overflow = 'auto';
          a.scrollTop = 40;
          return a.scrollTop;
        })()
      JS
      expect(got).to eq(40)
    end

    it 'puts the document offset on the BODY in quirks mode' do
      # `scrollingElement` is the body there, and Chrome measures the exact inverse of standards
      # mode: the body takes the write and the root ignores it.
      s = session_with('<html><body><div style="height: 3000px"></div></body></html>')
      got = s.evaluate_script(<<~JS)
        (() => {
          document.body.scrollTop = 100;
          document.documentElement.scrollTop = 100;
          return [document.compatMode,
                  document.scrollingElement === document.body,
                  document.body.scrollTop,
                  document.documentElement.scrollTop];
        })()
      JS
      expect(got).to eq(['BackCompat', true, 100, 0])
    end
  end
end
