# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's `load` is a task HTML "the end" queues once its parse is done and nothing delays its load event — one of
# its event loop's, in order with the tasks its parse queued, which the driver runs as the visit's load ends: no read of
# the test's is what fires it.
RSpec.describe 'the load "the end" queues' do
  def session_for(pages)
    simulated_session(lambda {|env|
      body = pages.fetch(env['PATH_INFO']) { next [404, {'content-type' => 'text/plain'}, ['']] }
      next body if body.is_a?(Array)

      type = env['PATH_INFO'].end_with?('.js') ? 'text/javascript' : 'text/html'
      [200, {'content-type' => type}, [body]]
    })
  end

  # Chrome 156, and Firefox 159 in a frame: a `setTimeout(0)` queued as the page parses runs before its load, a load
  # handler's after it (measured 2026-11-01).
  it 'runs after the tasks the parse queued, and before those its handlers queue' do
    s = session_for('/' => <<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.log = [];
        setTimeout(() => log.push('parse timeout'), 0);
        addEventListener('load', () => { log.push('load ' + document.readyState); setTimeout(() => log.push('load timeout'), 0); });
      </script>
    HTML
    s.visit '/'
    expect(s.evaluate_script('log')).to eq(['parse timeout', 'load complete', 'load timeout'])
  end

  # HTML "the end" step 7: the load waits for the set of scripts that will execute as soon as possible — an external
  # script a script inserted, and one that one inserted in turn, run before it.
  it 'waits for the external scripts inserted as the page loads' do
    s = session_for(
      '/'     => <<~HTML,
        <!DOCTYPE html><meta charset="utf-8"><script>
          window.log = [];
          addEventListener('load', () => log.push('load'));
          const s = document.createElement('script');
          s.src = '/a.js';
          document.head.append(s);
        </script>
      HTML
      '/a.js' => "log.push('a'); const t = document.createElement('script'); t.src = '/b.js'; document.head.append(t);",
      '/b.js' => "log.push('b');"
    )
    s.visit '/'
    expect(s.evaluate_script('log')).to eq(%w[a b load])
  end

  # A frame whose load handler navigates it again has loaded all the same: its container's `load` fires for it, and the
  # page's waits for none of the next document's (HTML "completely finish loading" queues the container's as the frame's
  # load task ends) — where one planned as it LOADED replaces it, and the container's load is the next document's.
  it "fires a frame's container load for a document whose load handler navigates it, not for one that navigated as it parsed" do
    s = session_for(
      '/'       => <<~HTML,
        <!DOCTYPE html><meta charset="utf-8"><body><script>window.log = [];</script>
        <iframe id="a" src="/reload"></iframe><iframe id="b" src="/parse"></iframe>
        <script>
          a.addEventListener('load', () => log.push('a'));
          b.addEventListener('load', () => log.push('b:' + b.contentWindow.location.pathname));
          addEventListener('load', () => log.push('page'));
        </script>
      HTML
      '/reload' => "<script>onload = () => { if (!parent.reloaded) { parent.reloaded = true; location.reload(); } };</script>",
      '/parse'  => "<script>location.href = '/done';</script>",
      '/done'   => 'done'
    )
    s.visit '/'
    s.document.synchronize(3) { raise Capybara::ExpectationNotMet if s.evaluate_script('log.length') < 4 }
    expect(s.evaluate_script('log')).to eq(['a', 'b:/done', 'page', 'a'])
  end
end
