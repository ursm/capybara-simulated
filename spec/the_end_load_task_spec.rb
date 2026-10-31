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

  # The images a page's style uses fetched before its load: HTML leaves open which CSS fetches delay the load event
  # (csswg-drafts#1088), and Chrome 156 and Firefox 159 both hold the load for a CSS background image (measured
  # 2026-11-01) — fetched at the end of the parse here, where a rendering update would fetch them.
  it 'fetches the images its style uses before its load' do
    s = session_for(
      '/'       => <<~HTML,
        <!DOCTYPE html><meta charset="utf-8"><style>#d { width: 10px; height: 10px; background-image: url(/bg.png) }</style>
        <div id="d"></div>
        <script>
          window.log = [];
          addEventListener('load', () => log.push(performance.getEntriesByType('resource').some((e) => e.name.endsWith('/bg.png'))));
        </script>
      HTML
      '/bg.png' => [200, {'content-type' => 'image/png'}, ['']]
    )
    s.visit '/'
    expect(s.evaluate_script('log')).to eq([true])
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

  # A frame whose load handler navigates it again has loaded all the same: its container's `load` fires for it (HTML
  # "completely finish loading" queues it as the frame's load task ends) — where one that navigated as it PARSED was
  # aborted ("navigate" → "abort a document and its descendants"), firing no load of its own nor its container's, and the
  # container's load is the next document's. The page's waits for both next documents: "navigate" sets the navigable's
  # "is delaying load events" until "finalize a cross-document navigation", and an iframe delays its document's load
  # while it is (Chrome 156 fires `b:/done` before the page's load; Firefox 159 the page's first).
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
    expect(s.evaluate_script('log')).to eq(['a', 'b:/done', 'a', 'page'])
  end

  # …and one that navigated as it parsed to a response that makes no document — a 204, a download — leaves the page
  # waiting on nothing once that navigation is finalized ("If historyEntry's document is null, then return", its
  # navigable delaying load events no more): its page's load fires, and no load of the aborted document's nor of its
  # container (Chrome).
  %w[/204 /dl.csv].each do |target|
    it "fires the page's load where a frame aborted as it parsed navigates to #{target}" do
      s = session_for(
        '/'       => <<~HTML,
          <!DOCTYPE html><meta charset="utf-8"><script>window.log = []; addEventListener('load', () => log.push('page'));</script>
          <iframe id="f" src="/nav" onload="log.push('container')"></iframe>
        HTML
        '/nav'    => "<script>location.href = '#{target}'; addEventListener('load', () => parent.log.push('frame'));</script>",
        '/204'    => [204, {}, []],
        '/dl.csv' => [200, {'content-type' => 'text/csv', 'content-disposition' => 'attachment; filename="a.csv"'}, ["a,b\n"]]
      )
      s.visit '/'
      s.has_css?('#never', wait: 0.5)
      expect(s.evaluate_script('log')).to eq(['page'])
    end
  end

  # …and a form submitted into a frame as the page parses, or from its DOMContentLoaded, whose response makes no document
  # — a 204 / 205, by GET or POST — likewise: the navigation finalized with none, the page's load fires (Chrome).
  {
    'as it parses'           => ['', '<script>fm.submit()</script>'],
    'from DOMContentLoaded'  => ["document.addEventListener('DOMContentLoaded', () => fm.submit());", ''],
    'by POST as it parses'   => ['', '<script>fm.method = "post"; fm.submit()</script>']
  }.each do |shape, (head, tail)|
    it "fires the page's load where a form submitted into a frame #{shape} is answered 204" do
      s = session_for(
        '/'    => <<~HTML,
          <!DOCTYPE html><meta charset="utf-8"><script>window.log = []; addEventListener('load', () => log.push('page')); #{head}</script>
          <iframe name="t" src="/c"></iframe><form id="fm" target="t" action="/204"><input name="a" value="1"></form>#{tail}
        HTML
        '/c'   => 'c',
        '/204' => [204, {}, []]
      )
      s.visit '/'
      s.has_css?('#never', wait: 0.5)
      expect(s.evaluate_script('log')).to eq(['page'])
    end
  end
end
