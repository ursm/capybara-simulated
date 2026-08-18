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

  # …and the poll loop still gets there: `have_text` re-queries until the timer
  # fires, which is the contract that makes reads advance the clock at all.
  it 'still lets a polling matcher advance the clock until a timer fires' do
    s = simulated_session(app(delay: 60))
    s.visit '/'

    expect(s).to have_css('.item', text: 'late0')
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
end
