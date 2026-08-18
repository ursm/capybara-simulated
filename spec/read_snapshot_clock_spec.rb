# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What reading an element does to the virtual clock.
#
# Reading `.text` off an already-found node advances it, because that is how a
# `have_text` poll makes progress: the matcher re-reads a cached scope node
# without going back through `find`, so nothing else in that loop would tick.
#
# But `all(…).map(&:text)` reads N elements of ONE query, back to back — in a
# browser no page time passes between them — and advancing per read walked the
# clock straight into whatever re-render those reads were racing. The elements
# `all` returned are then detached, and Capybara cannot recover: it hands back
# elements with `allow_reload: false`, so every retry re-reads the same dead
# nodes. Discourse's `tags_spec` reads its tag list exactly this way, right after
# a save that re-renders it.
# The DEFERRED half — a read of a different node owing a step that the next query
# pays — is measured by the WPT gate rather than here: dropping it (and keeping only
# the same-node tick) fails
# `html/semantics/forms/form-submission-0/form-data-set-usv.html` and
# `dom/events/event-global-is-still-set-when-coercing-beforeunload-result.html`,
# both of which drive a page through reads that never repeat a node.
RSpec.describe 'the virtual clock and element reads' do
  # A page that paints one `setTimeout(0)` in, then REPLACES its list on a short
  # timer — the shape a framework re-render has, and what makes a half-read
  # snapshot fatal rather than merely inconsistent.
  def app(delay:)
    lambda do |_env|
      body = <<~HTML
        <!doctype html><html><body>
          <div id="out">init</div>
          <div id="list"><div class="item">a</div><div class="item">b</div><div class="item">c</div></div>
          <script>
            setTimeout(() => { document.getElementById('out').textContent = 'ready'; }, 0);
            setTimeout(() => {
              document.getElementById('list').innerHTML =
                '<div class="item">late0</div><div class="item">late1</div><div class="item">late2</div>';
            }, #{delay});
          </script>
        </body></html>
      HTML
      [200, {'content-type' => 'text/html'}, [body]]
    end
  end

  # The page's own init has run by the time the test asks — a browser would have
  # run it during the load, and the first read is where the driver catches up.
  it 'runs the page init a browser would have run before the first read' do
    s = simulated_session(app(delay: 5_000))
    s.visit '/'

    expect(s.find('#out').text).to eq('ready')
  end

  # One query, one observation: reading its elements one by one must not walk the
  # clock into the timer that replaces them.
  it 'does not advance the clock while reading the elements of one query' do
    s = simulated_session(app(delay: 60))
    s.visit '/'
    s.find('#out')                        # let the init timer land, as above

    texts = s.all('.item').map(&:text)

    expect(texts).to eq(%w[a b c])
  end

  # …and a matcher polling ONE node still gets there. This is the half the deferral
  # can't take away: `assert_text` re-reads the node it was given without going back
  # through `find`, and for a node Capybara won't reload — anything from `all` /
  # `first`, or any node with `automatic_reload` off — no query will ever run to pay
  # a deferred step, so the read itself has to advance the clock when it is the same
  # node again. (This page rewrites the node's TEXT rather than replacing it, which
  # is what a text poll is for; a node that gets replaced goes stale under any
  # driver.)
  def updating_app(delay:)
    lambda do |_env|
      body = <<~HTML
        <!doctype html><html><body>
          <div class="v">waiting</div><div class="v">waiting</div>
          <script>
            setTimeout(() => {
              document.querySelectorAll('.v').forEach(el => { el.textContent = 'ready'; });
            }, #{delay});
          </script>
        </body></html>
      HTML
      [200, {'content-type' => 'text/html'}, [body]]
    end
  end

  it 'lets a matcher polling one non-reloadable node advance the clock' do
    s = simulated_session(updating_app(delay: 300))
    s.visit '/'

    expect { s.first('.v').assert_text('ready') }.not_to raise_error
  end

  # The same for a scope: `within` re-reads through the scope node.
  it 'lets a matcher polling inside a non-reloadable scope advance the clock' do
    s = simulated_session(updating_app(delay: 300))
    s.visit '/'

    expect { s.within(s.all('.v').first) { s.assert_text('ready') } }.not_to raise_error
  end

  # The negative form of the same contract, and the one that caught a wall-clock
  # throttle out: waiting for something to GO must reach the state where it is
  # gone. (Forem's notification badge, `not_to have_css(…, text: "1")`.)
  it 'still lets a polling matcher wait for content to disappear' do
    disappearing = lambda do |_env|
      body = <<~HTML
        <!doctype html><html><body>
          <span id="badge">1</span>
          <script>setTimeout(() => { document.getElementById('badge').remove(); }, 80);</script>
        </body></html>
      HTML
      [200, {'content-type' => 'text/html'}, [body]]
    end
    s = simulated_session(disappearing)
    s.visit '/'

    # `has_no_css?` rather than `not_to have_css` — this file doesn't load
    # capybara/rspec, so the negative matcher would fall through to RSpec's generic
    # predicate form (`has_css?` negated), which asks ONCE and waits for nothing.
    expect(s.has_no_css?('#badge', text: '1')).to be(true)
  end

  # The page's init runs with the LOAD, not with whatever the test does first —
  # which is the half that makes the snapshot walk above safe. Asserted through
  # `page.html`, a read that goes nowhere near an element handle or a matcher's
  # retry loop, so nothing but the load can have run the timer.
  it 'has run the page init by the time the visit returns' do
    initialising = lambda do |_env|
      body = <<~HTML
        <!doctype html><html><body>
          <div id="spinner">loading</div>
          <div id="later">still here</div>
          <script>
            setTimeout(() => { document.getElementById('spinner').remove(); }, 0);
            setTimeout(() => { document.getElementById('later').remove(); }, 5000);
          </script>
        </body></html>
      HTML
      [200, {'content-type' => 'text/html'}, [body]]
    end
    s = simulated_session(initialising)
    s.visit '/'

    html = s.html
    expect(html).not_to include('id="spinner"')
    expect(html).to include('id="later"')      # …and no further, so a delayed state is still observable
  end
end
