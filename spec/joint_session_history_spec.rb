# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The page's session history is ONE joint history of it and its frames (HTML §7.4.1, session_history.rs): a frame's
# navigation is a step of the page's — its `history.length` one more — and a traversal by a step, whichever navigable's
# `history` asks for it, moves whichever navigable's entry the step is. Chrome, measured 2026-10-24 (a page at /top
# with a frame at /f1, after the page's load):
#   frame to /f2         → length 2
#   page's back          → the frame at /f1, the page staying
#   page's forward       → the frame at /f2
#   frame's back         → the frame at /f1
#   frame's pushState    → length 2 (the forward step dropped)
#   page's pushState     → length 3
#   back                 → the page's popstate, at /top again, the frame staying
#   back                 → the frame back to /f1, same-document
RSpec.describe 'the joint session history' do
  let(:app) do
    lambda {|env|
      body = case env['PATH_INFO']
             when '/top' then '<iframe src="/f1"></iframe><script>addEventListener("popstate", () => document.title += "P")</script>'
             when '/f1' then 'F1<script>addEventListener("popstate", () => parent.document.title += "F")</script>'
             when '/f2' then 'F2'
             when '/b' then 'B'
             else 'START'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    }
  end
  let(:session) { simulated_session(app) }

  def frame_path = session.evaluate_script('frames[0].location.pathname')
  def length = session.evaluate_script('history.length')

  it "counts a frame's navigation a step of the page's" do
    session.visit '/top'
    expect(length).to eq(1)
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    expect(length).to eq(2)
  end

  it "takes the frame back on the page's back and forth on its forward" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.execute_script('history.back()')
    expect(frame_path).to eq('/f1')
    expect(session.current_path).to eq('/top')
    session.execute_script('history.forward()')
    expect(frame_path).to eq('/f2')
    session.execute_script('frames[0].history.back()')
    expect(frame_path).to eq('/f1')
    expect(length).to eq(2)
  end

  it 'takes the frame back on the session going back' do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.go_back
    expect(frame_path).to eq('/f1')
    expect(session.current_path).to eq('/top')
    session.go_forward
    expect(frame_path).to eq('/f2')
  end

  it "steps through the page's pushState and the frame's in the order they were made" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.execute_script('history.back()')
    expect(frame_path).to eq('/f1')
    session.execute_script('frames[0].history.pushState(null, "", "/f1x")')
    expect(length).to eq(2)
    session.execute_script('history.pushState(null, "", "/topx")')
    expect(length).to eq(3)
    session.execute_script('history.back()')
    expect(session.current_path).to eq('/top')
    expect(frame_path).to eq('/f1x')
    session.execute_script('history.back()')
    expect(frame_path).to eq('/f1')
    expect(session.evaluate_script('document.title')).to eq('PF')
  end

  # A frame's fragment navigation is an entry of its own, the one it left the URL it was at (a back gives it, a popstate
  # — /f1's listener writes the F — and a hashchange).
  it "goes back over a frame's fragment navigation" do
    session.visit '/top'
    session.execute_script('frames[0].addEventListener("hashchange", () => document.title += "H"); frames[0].location.hash = "x"')
    expect(session.evaluate_script('frames[0].location.hash')).to eq('#x')
    expect(length).to eq(2)
    session.execute_script('history.back()')
    expect(session.evaluate_script('frames[0].location.href')).to end_with('/f1')
    expect(session.evaluate_script('document.title')).to eq('HFH')
  end

  # A frame's document made again by a traversal starts with its entry's classic history API state (HTML "update
  # document for history step application"), as the page's does.
  it "restores a frame entry's history state" do
    session.visit '/top'
    session.execute_script('frames[0].history.pushState({a: 1}, "", "/f1x")')
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.go_back
    expect(frame_path).to eq('/f1x')
    expect(session.evaluate_script('frames[0].history.state')).to eq({'a' => 1})
  end

  # …that frame's, not one a handler of the document it leaves makes on the way.
  it "restores the state to the traversed frame alone" do
    session.visit '/top'
    session.execute_script('frames[0].history.pushState({a: 1}, "", "/f1x")')
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.execute_script('frames[0].addEventListener("pagehide", () => document.body.append(document.createElement("iframe")))')
    session.go_back
    expect(frame_path).to eq('/f1x')
    expect(session.evaluate_script('frames[0].history.state')).to eq({'a' => 1})
    expect(session.evaluate_script('frames[1] && frames[1].history.state')).to be_nil
  end

  # A frame's container removed: its navigable destroyed, its steps none of the page's (HTML "destroy a child
  # navigable"; Chrome keeps them, the spec says otherwise).
  it "drops a removed frame's steps" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    expect(length).to eq(2)
    session.execute_script('const f = document.querySelector("iframe"); f.remove(); document.body.append(f)')
    expect(length).to eq(1)
  end

  # A timer of the page due as the session goes forward runs first — its pushState dropping the forward step the
  # traversal was to go to, which then goes to the pushed entry.
  it 'plans a traversal after the outgoing page has run what was due' do
    session.visit '/top'
    session.visit '/b'
    session.go_back
    session.execute_script('setTimeout(() => history.pushState(null, "", "/top2"), 0)')
    session.go_forward
    expect(session.current_path).to eq('/top2')
    expect(length).to eq(2)
  end

  # …and, the page staying after all (the traversal now a same-document one), what those timers planned still stands.
  it "keeps what the outgoing page's timers planned when it stays" do
    session.visit '/top'
    session.visit '/b'
    session.execute_script('setTimeout(() => { history.pushState(null, "", "/b2"); location.href = "/f2" }, 0)')
    session.go_back
    expect(session).to have_current_path('/f2')
  end

  # The application's error in a traversal's request is the test's, as a visit's is.
  it "raises the application's error of a traversal" do
    gets = 0
    session = simulated_session(lambda {|env|
      gets += 1 if env['PATH_INFO'] == '/b'
      raise 'boom' if gets == 2

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>x']]
    })
    session.visit '/a'
    session.visit '/b'
    session.go_back
    expect { session.go_forward }.to raise_error(RuntimeError, 'boom')
  end

  # A window `window.open` made is a traversable of its own: its `history` is its initial about:blank's, not the
  # opener's.
  it "keeps a new window's history its own" do
    session.visit '/top'
    session.visit '/b'
    session.execute_script('window.w = window.open(); w.history.back()')
    expect(session.evaluate_script('w.history.length')).to eq(1)
    expect(session.current_path).to eq('/b')
  end

  # A traversal is a task of its own (the session history traversal queue, which answers in parallel): a same-document
  # one's popstate after the script that asked, its microtasks and the tasks due as it ends — timers set before it and
  # after (Chrome and Firefox, measured 2026-10-24 in real time).
  %w[execute_script click].each do |how|
    it "fires a traversal's popstate after what is due (#{how})" do
      session.visit '/top'
      session.execute_script(<<~JS)
        window.o = [];
        addEventListener('popstate', () => o.push('pop'));
        window.go = () => {
          setTimeout(() => o.push('t0'), 0);
          history.pushState(null, '', '/top2');
          history.back();
          setTimeout(() => o.push('t1'), 0);
          Promise.resolve().then(() => o.push('micro'));
          o.push('after');
        };
        const b = document.createElement('button'); b.textContent = 'Go'; b.onclick = go; document.body.append(b);
      JS
      how == 'click' ? session.click_button('Go') : session.execute_script('go()')
      expect(session).to have_current_path('/top')
      expect(session.evaluate_script('o')).to eq(%w[after micro t0 t1 pop])
    end
  end

  # …which the driver applies as it takes what the page planned: a visit after the script is a navigation from the
  # entry the traversal went to (Chrome runs the task as the script ends).
  it 'applies a traversal the script asked for before the next visit' do
    session.visit '/top'
    session.execute_script("history.pushState(null, '', '/top2'); history.back()")
    session.visit '/b'
    expect(length).to eq(2)
    session.go_back
    expect(session.current_path).to eq('/top')
  end

  # A traversal making a navigable's document again cancels the navigation planned for it, whichever came first (HTML
  # "apply the history step"; Chrome and Firefox, measured 2026-10-24: /x never requested).
  {'after' => 'history.back(); location.href = "/x"', 'before' => 'location.href = "/x"; history.back()'}.each do |order, js|
    it "goes back rather than to a location set #{order} it" do
      hits = []
      session = simulated_session(lambda {|env|
        hits << env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{env['PATH_INFO']}"]]
      })
      session.visit '/a'
      session.visit '/b'
      session.execute_script(js)
      expect(session).to have_current_path('/a')
      expect(hits).not_to include('/x')
      expect(session.evaluate_script('history.length')).to eq(2)
    end
  end

  # …and a navigation of the page planned with a traversal that moves it within its document and its frame across
  # them goes on after it (Chrome and Firefox: at /x, length 2).
  it 'navigates after a traversal that keeps the page in its document' do
    hits = []
    session = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      body = env['PATH_INFO'] == '/top' ? '<iframe src="/f1"></iframe>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f2')
    session.execute_script('history.pushState(null, "", "/top2")')
    session.execute_script('history.go(-2); location.href = "/x"')
    expect(session).to have_current_path('/x')
    expect(session.evaluate_script('history.length')).to eq(2)
  end

  # A form of the page's planning a navigation of a frame a traversal makes the document of again plans none (HTML
  # "apply the history step"; Chrome and Firefox: the frame at /f1, /x never requested).
  it "cancels a form's navigation of a frame the traversal takes back" do
    hits = []
    session = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      body = env['PATH_INFO'] == '/top' ? '<iframe name=n src="/f1"></iframe><form id=f method=post target=n action="/x"></form>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f2')
    session.execute_script('history.back(); f.submit()')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f1')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f1')
    expect(session.evaluate_script('history.length')).to eq(2)
  end

  it "goes back rather than to a frame's src set after it" do
    hits = []
    session = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      body = env['PATH_INFO'] == '/top' ? '<iframe src="/f1"></iframe>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f2')
    session.execute_script('const f = document.querySelector("iframe"); f.contentWindow.history.back(); f.src = "/x"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f1')
    expect(hits).not_to include('/x')
    expect(session.evaluate_script('history.length')).to eq(2)
  end

  # The page navigated on: its frames' steps stay steps of the document it left (Chrome: 3 after /b), and a traversal
  # back to it makes it again, its frames with it.
  it "keeps a frame's steps once the page has navigated on" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.visit '/b'
    expect(length).to eq(3)
    session.go_back
    expect(session.current_path).to eq('/top')
  end
end
