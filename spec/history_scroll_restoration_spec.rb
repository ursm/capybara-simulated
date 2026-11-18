# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `history.scrollRestoration` is the scroll restoration mode of the navigable's active session history ENTRY (HTML): an
# entry of the same document — a pushState's, a fragment navigation's — takes the mode of the one it comes after, an
# entry of a new document starts at "auto", and a traversal finds each entry's again. Chrome 157 and Firefox 159,
# measured 2026-11-19: `manual, push → manual, auto, #c → auto, manual; back → auto; back → manual; go(2) → manual`, and
# a document navigated to from a "manual" one starts "auto" (Firefox's traversal back to that one: "manual").
RSpec.describe 'history.scrollRestoration' do
  let(:session) {
    simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/frame' ? '<iframe src="/inner"></iframe>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=\"utf-8\"><body>#{body}"]]
    })
  }

  it "is the active entry's, which an entry of the same document takes of the one it comes after" do
    session.visit('/a')
    session.execute_script(<<~JS)
      window.log = [];
      history.scrollRestoration = 'manual';
      history.pushState(null, '', '#b');
      log.push('b:' + history.scrollRestoration);
      history.scrollRestoration = 'auto';
      location.hash = 'c';
      log.push('c:' + history.scrollRestoration);
      history.scrollRestoration = 'manual';
      history.replaceState(null, '', '#c2');
      log.push('c2:' + history.scrollRestoration);
      let n = 0;
      addEventListener('popstate', () => {
        n++;
        log.push('pop' + location.hash + ':' + history.scrollRestoration);
        if (n === 1) history.back();
        else if (n === 2) history.go(2);
      });
      history.back();
    JS
    poll_until { session.evaluate_script('window.log.length') == 6 }
    expect(session.evaluate_script('window.log')).to eq(['b:manual', 'c:auto', 'c2:manual', 'pop#b:auto', 'pop:manual', 'pop#c2:manual'])
  end

  it "starts a new document's entry at auto, and a traversal back finds the one it left" do
    session.visit('/a')
    session.execute_script("history.scrollRestoration = 'manual'")
    session.visit('/b')
    expect(session.evaluate_script('history.scrollRestoration')).to eq('auto')
    session.go_back
    expect(session.current_path).to eq('/a')
    expect(session.evaluate_script('history.scrollRestoration')).to eq('manual')
  end

  it "is a frame's own entry's, not its top-level one's" do
    session.visit('/frame')
    session.execute_script("frames[0].history.pushState(null, '', '/inner2'); frames[0].history.scrollRestoration = 'manual'")
    expect(session.evaluate_script('[history.scrollRestoration, frames[0].history.scrollRestoration]')).to eq(%w[auto manual])
  end

  # …a frame's set before it has an entry of its own, which the entries after it take (no `src`: its initial about:blank).
  it "is kept by a frame's first entry" do
    session.visit('/a')
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      document.body.append(f);
      f.contentWindow.history.scrollRestoration = 'manual';
      f.contentWindow.history.pushState('s', '');
    JS
    expect(session.evaluate_script('frames[0].history.scrollRestoration')).to eq('manual')
  end

  # …and one a document set as it was unloaded is its own entry's, not the next document's.
  it "is not the next entry's as the document is unloaded" do
    session.visit('/a')
    session.execute_script("addEventListener('pagehide', () => { history.scrollRestoration = 'manual'; })")
    session.visit('/b')
    expect(session.evaluate_script('history.scrollRestoration')).to eq('auto')
  end
end
