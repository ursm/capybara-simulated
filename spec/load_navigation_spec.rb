# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A navigation of the page its document plans as it loads — its location set, a form submitted, a link followed, by its
# parse, a `load` handler or a task its load runs — is under way as the visit ends, as a browser starts it then: an
# auto-submitting page (an OAuth `form_post`) has navigated by the time `current_path` is read.
RSpec.describe 'a navigation a page plans as it loads' do
  {
    'its location set as it parses'    => '<script>location.href = "/b"</script>',
    'a form submitted as it parses'    => '<form id=f action="/b"><input name=q value=1></form><script>f.submit()</script>',
    'a form submitted on its load'     => '<form id=f action="/b"><input name=q value=1></form><script>addEventListener("load", () => f.submit())</script>',
    'a link clicked as it parses'      => '<a id=a href="/b">x</a><script>a.click()</script>',
    'a form submitted on a task'       => '<form id=f action="/b"><input name=q value=1></form><script>setTimeout(() => f.submit(), 0)</script>',
    "a frame's _top form as it parses" => '<iframe srcdoc="<form id=f action=/b target=_top></form><script>f.submit()</script>"></iframe>'
  }.each do |name, body|
    it "has navigated by the end of the visit: #{name}" do
      session = simulated_session(lambda {|env|
        next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>B']] if env['PATH_INFO'] == '/b'

        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>A#{body}"]]
      })
      session.visit '/'
      expect(session.current_path).to eq('/b')
      expect(session.evaluate_script('document.body.textContent')).to eq('B')
    end
  end

  # …and by the end of whatever action reached the page: a button's submission to an auto-submitting page (an OAuth
  # provider's `form_post`) lands where that page submits to.
  it 'has navigated by the end of a click that reached the page' do
    session = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/authorize' then '<form id=f method=post action="/callback"><input name=code value=x></form><script>f.submit()</script>'
             when '/callback' then 'Welcome'
             else '<form method=post action="/authorize"><button>Sign in</button></form>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/'
    session.click_button 'Sign in'
    expect(session.current_path).to eq('/callback')
  end

  # A navigation a document plans before it is completely loaded replaces its session history entry (HTML
  # "Location-object navigate", form submission's "plan to navigate"): a traversal back skips the auto-submitting page,
  # which would only submit again (Chrome: `/start` after `go_back`, one POST).
  it 'leaves no entry of an auto-submitting page to go back to' do
    posts = 0
    session = simulated_session(lambda {|env|
      posts += 1 if env['PATH_INFO'] == '/callback'
      body = case env['PATH_INFO']
             when '/authorize' then '<form id=f method=post action="/callback"><input name=code value=x></form><script>f.submit()</script>'
             when '/callback' then 'Welcome'
             else 'START'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/start'
    session.visit '/authorize'
    expect(session.current_path).to eq('/callback')
    session.go_back
    expect(session.current_path).to eq('/start')
    expect(posts).to eq(1)
  end

  # …its own entry, not the page's: a frame's `_top` form submitted as the frame parses adds the page an entry (Chrome:
  # `history.length` one more).
  it "adds the page an entry for a frame's parse-time `_top` form" do
    session = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/fsub' then '<iframe srcdoc="<form id=f action=/b target=_top></form><script>f.submit()</script>"></iframe>'
             when '/b' then 'B'
             else 'START'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/start'
    session.visit '/fsub'
    expect(session.current_path).to eq('/b')
    expect(session.evaluate_script('history.length')).to eq(3)
  end

  # A frame's `_parent` form submitted as a nested frame parses navigates its parent frame, not the page (Chrome).
  it "navigates the parent a nested frame's parse-time `_parent` form chooses" do
    session = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/mid' then 'MID<iframe src="/inner"></iframe>'
             when '/inner' then '<form id=f action="/done" target=_parent></form><script>f.submit()</script>'
             when '/done' then 'DONE'
             else 'TOP<iframe src="/mid"></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/'
    expect(session.current_path).to eq('/')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/done')
  end
end
