require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# `scroll` (CSSOM-View "Scrolling events") is a PENDING SCROLL EVENT TARGET, the
# same as `scrollend`: scrolling a box adds it to the document's pending set and
# the event fires at the next "update the rendering" step — coalesced to one per
# scroller per frame, and never synchronously from the assignment that moved it.
#
# Both halves are load-bearing for an SPA. Turbo's `ScrollObserver` records
# `window.pageYOffset` into the CURRENT history entry on every `scroll`; fired
# synchronously, the `scrollTo(0, 0)` Turbo's own visit performs raced the
# restoration-identifier swap and wrote 0 over the OUTGOING page's saved position,
# so `page.go_back` came back to the top of the page — and a lazy `<turbo-frame>`
# below the fold was never scrolled into view, so it never loaded (Avo's
# `tabs_spec` "keeps the pagination on tab when back is used").
#
# Every expectation here is real Chrome's, read off the same markup with
# `--headless --dump-dom`.
RSpec.describe 'scroll event' do
  def session
    app = lambda do |_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head></head><body style="margin:0">' \
        '<div id="s" style="overflow:scroll;height:100px"><div style="height:4000px"></div></div>' \
        '<div style="height:4000px"></div></body></html>']]
    end
    s = simulated_session(app)
    s.visit '/'
    s
  end

  # Drive the event loop so the render-phase scroll flush runs.
  def pump(s, n = 5)
    n.times { s.evaluate_script("typeof __runLoopStep === 'function' ? __runLoopStep(50, 50, false) : null") }
  end

  it 'delivers one event per scroller per frame, after the task that moved it' do
    s = session
    s.execute_script(<<~JS)
      window.__el = 0; window.__sync = null;
      const el = document.getElementById('s');
      el.addEventListener('scroll', () => { window.__el++; });
      el.scrollTop = 10;
      el.scrollTop = 20;
      el.scrollTop = 30;
      window.__sync = window.__el;
    JS
    # Chrome: still 0 in the task that did the scrolling, and exactly 1 afterwards
    # however many times the offset moved.
    expect(s.evaluate_script('window.__sync')).to eq(0)
    pump(s)
    expect(s.evaluate_script('window.__el')).to eq(1)
  end

  # The regression this file's `pump` helper can hide: the driver's settle loop only runs a loop
  # step when a timer, a fetch or a message is pending, so a page that just SCROLLS runs no frame
  # of its own. Every example below drives the loop by hand; a real test does not, and delivery has
  # to happen anyway — a scroll handler that appends to the DOM is what `assert_selector` is then
  # waiting for.
  it 'delivers on a quiet page, with nothing driving the loop' do
    s = session
    s.execute_script(<<~JS)
      window.addEventListener('scroll', () => {
        const d = document.createElement('div');
        d.id = 'added';
        document.body.appendChild(d);
      });
      window.scrollTo(0, 500);
    JS
    expect(s).to have_css('#added', wait: 2)
  end

  it 'delivers what scroll_to and scrollIntoView scroll, at the window' do
    s = session
    s.execute_script('window.__win = 0; window.addEventListener("scroll", () => { window.__win++; });')
    s.scroll_to(0, 3000)
    expect(s.evaluate_script('window.__win')).to eq(1)
    # `scrollIntoView` scrolls the VIEWPORT, so its event belongs to the viewport — dispatching it
    # at the element scrolled INTO view reached no window listener at all.
    s.execute_script('window.__win = 0; document.querySelector("#s > div").scrollIntoView();')
    expect(s.evaluate_script('window.__win')).to eq(1)
    # …and a scrollIntoView that moves nothing fires nothing (Chrome).
    s.execute_script('window.__win = 0; document.querySelector("#s > div").scrollIntoView();')
    expect(s.evaluate_script('window.__win')).to eq(0)
  end

  it 'keeps an element scroller off document and window' do
    s = session
    s.execute_script(<<~JS)
      window.__el = 0; window.__doc = 0; window.__win = 0;
      const el = document.getElementById('s');
      el.addEventListener('scroll', () => { window.__el++; });
      document.addEventListener('scroll', () => { window.__doc++; });
      window.addEventListener('scroll', () => { window.__win++; });
      el.scrollTop = 30;
    JS
    pump(s)
    # Chrome: 1 / 0 / 0 — a `scroll` event does not bubble.
    expect(s.evaluate_script('[window.__el, window.__doc, window.__win]')).to eq([1, 0, 0])
  end

  it 'fires the viewport scroll at the document, bubbling to the window once' do
    s = session
    s.execute_script(<<~JS)
      window.__doc = 0; window.__win = 0; window.__cap = 0; window.__shape = null;
      document.addEventListener('scroll', () => { window.__doc++; });
      window.addEventListener('scroll', (e) => {
        window.__win++;
        window.__shape = [e.bubbles, e.target === document ? 'document' : 'other', e.eventPhase];
      }, false);
      window.addEventListener('scroll', () => { window.__cap++; }, true);
      document.scrollingElement.scrollTop = 200;
    JS
    pump(s)
    expect(s.evaluate_script('[window.__doc, window.__win, window.__cap]')).to eq([1, 1, 1])
    # Chrome: the viewport's scroll is dispatched AT THE DOCUMENT and bubbles from there, which is
    # how window listeners see it. Reaching them with a second explicit dispatch instead fired a
    # window CAPTURE listener twice and reported the window as the target.
    expect(s.evaluate_script('window.__shape')).to eq([true, 'document', 3])
  end

  it 'still fires the scroll of a scroller removed before the rendering update' do
    s = session
    s.execute_script(<<~JS)
      window.__el = 0;
      const el = document.getElementById('s');
      el.addEventListener('scroll', () => { window.__el++; });
      el.scrollTop = 30;
      el.remove();
    JS
    pump(s)
    # Chrome 151: 1. "Run the scroll steps" has no connectedness test — the box scrolled, so it
    # gets its event whether or not it is still in the tree when the frame runs.
    expect(s.evaluate_script('window.__el')).to eq(1)
  end

  it 'queues nothing for a scroll that does not move the box' do
    s = session
    s.execute_script(<<~JS)
      window.__el = 0;
      const el = document.getElementById('s');
      el.scrollTop = 30;
    JS
    pump(s)
    s.execute_script(<<~JS)
      const el = document.getElementById('s');
      el.addEventListener('scroll', () => { window.__el++; });
      el.scrollTop = 30;
    JS
    pump(s)
    expect(s.evaluate_script('window.__el')).to eq(0)
  end
end
