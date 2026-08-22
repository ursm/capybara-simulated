require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# IntersectionObserver against the layout engine. What matters most is the half a "fires
# isIntersecting: true once" stub can never report — LEAVING, and never entering at all — because
# that is what apps key their behavior on (Discourse swaps the header's auth buttons for the topic
# title when the title scrolls OUT of view).
#
# The initial-notification expectations are real Chrome's, read off the same markup with
# `--headless --dump-dom` over http at 1024x768.
RSpec.describe 'IntersectionObserver' do
  def body
    <<~HTML
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 }
        #spacer { height: 2000px }
        #below { height: 100px }
        #scroller { height: 100px; overflow: scroll }
        #inner { height: 400px }
        #deep { height: 20px }
      </style></head><body>
        <div id="top" style="height:50px"></div>
        <div id="spacer"></div>
        <div id="below">below the fold</div>
        <div id="scroller"><div id="inner"><div id="deep"></div></div></div>
      </body></html>
    HTML
  end

  def session
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  # Record every entry an observer delivers as "id:isIntersecting:ratio".
  def observe(s, script)
    s.execute_script(<<~JS)
      window.__io = [];
      window.__rec = (es) => { for (const e of es) window.__io.push([e.target.id, e.isIntersecting, e.intersectionRatio.toFixed(2)].join(':')); };
      #{script}
    JS
    pump(s)
  end

  def pump(s, n = 5)
    n.times { s.evaluate_script("typeof __runLoopStep === 'function' ? __runLoopStep(50, 50, false) : null") }
  end

  def entries(s) = s.evaluate_script('window.__io')

  it 'reports a target below the fold as NOT intersecting' do
    s = session
    observe(s, "new IntersectionObserver(window.__rec).observe(document.getElementById('below'));")
    # Chrome: below:false:0.00 — the initial notification is delivered either way.
    expect(entries(s)).to eq(['below:false:0.00'])
  end

  it 'reports a visible target as fully intersecting' do
    s = session
    observe(s, "new IntersectionObserver(window.__rec).observe(document.getElementById('top'));")
    expect(entries(s)).to eq(['top:true:1.00'])   # Chrome: top:true:1.00
  end

  it 'notifies on both leaving and entering as the page scrolls' do
    s = session
    observe(s, <<~JS)
      const io = new IntersectionObserver(window.__rec);
      io.observe(document.getElementById('top'));
      io.observe(document.getElementById('below'));
    JS
    expect(entries(s)).to eq(['top:true:1.00', 'below:false:0.00'])

    s.execute_script('window.scrollTo(0, 2100)')
    pump(s)

    # A scroll CLAMPS to the scrollable range, as a browser's does — Chrome measured on this exact
    # markup: `scrollTo(0, 2100)` lands at 1569 of a 2250-tall page in a 681-tall viewport. Ours
    # lands at 1482 (2250 − 768), which puts `below` (y 2050..2150) fully inside it.
    expect(entries(s)).to eq(['top:true:1.00', 'below:false:0.00', 'top:false:0.00', 'below:true:1.00'])
  end

  it 'honours rootMargin' do
    s = session
    observe(s, "new IntersectionObserver(window.__rec, {rootMargin: '3000px'}).observe(document.getElementById('below'));")
    expect(entries(s)).to eq(['below:true:1.00'])   # Chrome: below:true:1.00
  end

  it 'honours an element root and its clipping' do
    s = session
    observe(s, "new IntersectionObserver(window.__rec, {root: document.getElementById('scroller')}).observe(document.getElementById('deep'));")
    expect(entries(s)).to eq(['deep:true:1.00'])    # Chrome: deep:true:1.00

    # Scroll the container past the target: it is clipped away, so it stops intersecting.
    s.execute_script("document.getElementById('scroller').scrollTop = 300")
    pump(s)
    expect(entries(s).last).to eq('deep:false:0.00')
  end

  it 'only notifies when a threshold is crossed' do
    s = session
    observe(s, "new IntersectionObserver(window.__rec, {threshold: 0.75}).observe(document.getElementById('below'));")
    expect(entries(s)).to eq(['below:false:0.00'])

    # Half visible — below the 0.75 threshold, so no notification. (1400 leaves the viewport at
    # 1400..2168 against `below` at 2050..2150: 118 of its 100px… so scroll to where exactly half
    # shows, 2000, and stay under the threshold.)
    s.execute_script('window.scrollTo(0, 1332)')
    pump(s)
    expect(entries(s)).to eq(['below:false:0.00'])

    # Fully visible — crosses it. (Clamped to 1482, which shows all of it.)
    s.execute_script('window.scrollTo(0, 2050)')
    pump(s)
    expect(entries(s)).to eq(['below:false:0.00', 'below:true:1.00'])
  end

  # The delivery model is FRAME-PACED: every producer (observe()'s initial
  # notification included) only raises a pending flag, and the render phase of
  # the next event-loop step is the one delivery site. An app whose callback
  # re-observes its target (Discourse's composer-image-node) therefore advances
  # one round per step — in the eager-microtask model it looped unboundedly
  # inside a single step, spinning thousands of layout passes (the ProseMirror
  # composer hang).
  it 'paces a callback that re-observes at one round per step' do
    s = session
    s.execute_script(<<~JS)
      window.__rounds = 0;
      const target = document.getElementById('top');
      const reobserve = () => {
        const io = new IntersectionObserver((_es, self) => {
          window.__rounds++;
          self.disconnect();
          if (window.__rounds < 1000) reobserve();
        });
        io.observe(target);
      };
      reobserve();
    JS
    pump(s, 8)
    rounds = s.evaluate_script('window.__rounds')
    expect(rounds).to be_between(1, 30)
  end

  it 'exposes the spec-shaped surface' do
    s = session
    s.execute_script(<<~JS)
      window.__io2 = new IntersectionObserver(() => {}, {rootMargin: '10px 20%', threshold: [0.5, 0.25]});
      window.__probe = {
        root: window.__io2.root, rootMargin: window.__io2.rootMargin,
        thresholds: window.__io2.thresholds, records: window.__io2.takeRecords()
      };
    JS
    expect(s.evaluate_script('window.__probe.root')).to be_nil
    expect(s.evaluate_script('window.__probe.rootMargin')).to eq('10px 20% 10px 20%')
    expect(s.evaluate_script('window.__probe.thresholds')).to eq([0.25, 0.5])   # sorted
    expect(s.evaluate_script('window.__probe.records')).to eq([])
    # Invalid arguments throw, as the constructor's WebIDL says.
    expect(s.evaluate_script("(() => { try { new IntersectionObserver(() => {}, {threshold: 2}); return 'no-throw'; } catch (e) { return e.name; } })()")).to eq('RangeError')
    expect(s.evaluate_script("(() => { try { new IntersectionObserver(() => {}, {rootMargin: '1em'}); return 'no-throw'; } catch (e) { return e.name; } })()")).to eq('SyntaxError')
  end
end
