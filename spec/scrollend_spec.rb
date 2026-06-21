require 'capybara/simulated'
require 'rack'

# `scrollend` (CSSOM-View): the driver models the spec "pending scroll event
# targets" — scrollend is queued on a position change and dispatched at the next
# rendering update (not synchronously), so a scroller removed before then has its
# pending scrollend dropped. An element scroller fires on the element only
# (bubbles:false); the viewport scroller fires at the document (bubbles:true),
# reaching a window listener exactly once via bubbling.
RSpec.describe 'scrollend event' do
  def session
    app = lambda do |_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head></head><body><div id="s" style="overflow:scroll">' \
        '<div style="height:4000px"></div></div></body></html>']]
    end
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  # Drive the event loop so the render-phase scrollend flush runs.
  def pump(s, n = 5)
    n.times { s.evaluate_script("typeof __runLoopStep === 'function' ? __runLoopStep(50, 50, false) : null") }
  end

  it 'fires scrollend on an element scroller once, non-bubbling, not on document/window' do
    s = session
    s.execute_script(<<~JS)
      window.__el = 0; window.__doc = 0; window.__win = 0; window.__bubbles = null;
      const el = document.getElementById('s');
      el.addEventListener('scrollend', e => { window.__el++; window.__bubbles = e.bubbles; });
      document.addEventListener('scrollend', () => { window.__doc++; });
      window.addEventListener('scrollend', () => { window.__win++; });
      el.scrollTop = 100;
    JS
    pump(s)
    expect(s.evaluate_script('window.__el')).to eq(1)        # fired once on the element
    expect(s.evaluate_script('window.__bubbles')).to eq(false)
    expect(s.evaluate_script('window.__doc')).to eq(0)       # element scroll does NOT reach document
    expect(s.evaluate_script('window.__win')).to eq(0)       # ...nor window
  end

  it 'fires the viewport scrollend on a window listener exactly once (no double-fire)' do
    s = session
    s.execute_script(<<~JS)
      window.__win = 0; window.__doc = 0; window.__bubbles = null;
      window.addEventListener('scrollend', e => { window.__win++; window.__bubbles = e.bubbles; });
      document.addEventListener('scrollend', () => { window.__doc++; });
      document.scrollingElement.scrollTop = 200;
    JS
    pump(s)
    expect(s.evaluate_script('window.__win')).to eq(1)       # once, via document→window bubbling
    expect(s.evaluate_script('window.__doc')).to eq(1)
    expect(s.evaluate_script('window.__bubbles')).to eq(true)
  end

  it 'does not fire scrollend on a no-op (unchanged-position) scroll' do
    s = session
    s.execute_script(<<~JS)
      window.__el = 0;
      const el = document.getElementById('s');
      el.scrollTop = 0;   // already 0 — no change
      el.addEventListener('scrollend', () => { window.__el++; });
      el.scrollTop = 0;
    JS
    pump(s)
    expect(s.evaluate_script('window.__el')).to eq(0)
  end

  it 'drops a pending scrollend when the scroller is removed before the render update' do
    s = session
    s.execute_script(<<~JS)
      window.__fired = 0;
      const el = document.getElementById('s');
      el.addEventListener('scrollend', () => { window.__fired++; });
      el.scrollTop = 100;        // queues a pending scrollend
      el.remove();               // ...removed before the render-phase flush
    JS
    pump(s)
    expect(s.evaluate_script('window.__fired')).to eq(0)
  end
end
