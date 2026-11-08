# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# An entry's document state's request referrer is the one Fetch determined for the request that made it — after a
# redirect's `Referrer-Policy` (HTML "populate a history entry": "client" until then, the request's referrer) — and a
# reload or a traversal of it refers by it again, the page's, a frame's and a pop-up's alike: a redirect that cut it to
# its origin sends the origin again (Chrome 157, Firefox 159), one that cut it off none. A traversal a script asks for is
# made by the navigable's active document (HTML "apply the history step": no source snapshot given, its user involvement
# none — Firefox 159 sends `same-origin`), the user's by none (`none`).
RSpec.describe 'a session history entry request referrer', :https do
  include PollUntil

  let(:seen) { [] }
  let(:session) do
    seen = self.seen
    every_host_local {
      simulated_session(lambda {|env|
        path = env['PATH_INFO']
        seen << [path, env['HTTP_REFERER'], env['HTTP_SEC_FETCH_SITE']] unless path == '/favicon.ico'
        html = ->(body) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
        case path
        when '/origin' then [302, {'location' => '/f2', 'referrer-policy' => 'origin'}, []]
        when '/none' then [302, {'location' => '/f2', 'referrer-policy' => 'no-referrer'}, []]
        when '/top' then html.('<iframe name=f src=/f1></iframe>')
        when '/f1', '/p1' then html.("<title>#{path}</title><a id=o href=/origin>o</a><a id=n href=/none>n</a>")
        else html.("<title>#{path}</title><a href=/other>other</a>")
        end
      })
    }
  end

  def referers_of(path) = seen.select {|p, _| p == path }.map {|_, r, _| r }
  def ev(js) = session.evaluate_script(js)

  {'origin' => 'https://www.example.com/', 'none' => nil}.each do |redirect, sent|
    it "refers a traversal back to an entry a redirect's #{redirect} policy referred as the redirect left it, the page's" do
      session.visit '/p1'
      session.click_link redirect[0]
      expect(session).to have_title('/f2')
      session.click_link 'other'
      expect(session).to have_title('/other')
      session.go_back
      expect(session).to have_title('/f2')
      expect(referers_of('/f2')).to eq([sent, sent])
    end

    it "…a frame's" do
      session.visit '/top'
      session.within_frame('f') { session.click_link redirect[0] }
      expect(poll_until { ev('frames[0].document.title') == '/f2' }).to be(true)
      session.within_frame('f') { session.click_link 'other' }
      expect(poll_until { ev('frames[0].document.title') == '/other' }).to be(true)
      session.execute_script('history.back()')
      expect(poll_until { referers_of('/f2').size == 2 }).to be(true)
      expect(referers_of('/f2')).to eq([sent, sent])
    end

    it "…a pop-up's, and its reloads, a script's and the user's" do
      session.visit '/a'
      session.execute_script('window.w = open("/p1")')
      expect(poll_until { ev('w.document.title') == '/p1' }).to be(true)
      session.execute_script("w.document.getElementById('#{redirect[0]}').click()")
      expect(poll_until { ev('w.document.title') == '/f2' }).to be(true)
      session.execute_script('w.location.reload()')
      expect(poll_until { referers_of('/f2').size == 2 }).to be(true)
      session.within_window(session.windows.last) { session.refresh }
      expect(poll_until { referers_of('/f2').size == 3 }).to be(true)
      session.execute_script('w.location = "/c"')
      expect(poll_until { ev('w.document.title') == '/c' }).to be(true)
      session.execute_script('w.history.back()')
      expect(poll_until { referers_of('/f2').size == 4 }).to be(true)
      expect(referers_of('/f2')).to eq([sent] * 4)
    end
  end

  it "refers the page's reload as its entry's request was, a visit's by none" do
    session.visit '/p0'
    session.click_link 'other'
    expect(session).to have_title('/other')
    session.execute_script('location.reload()')
    expect(poll_until { referers_of('/other').size == 2 }).to be(true)
    session.visit '/v'
    session.execute_script('location.reload()')
    expect(poll_until { referers_of('/v').size == 2 }).to be(true)
    expect([referers_of('/other'), referers_of('/v')]).to eq([['https://www.example.com/p0'] * 2, [nil, nil]])
  end

  it "makes the page's traversal a script asks for by its document, the user's by none" do
    session.visit '/p0'
    session.click_link 'other'
    expect(session).to have_title('/other')
    session.execute_script('history.back()')
    expect(session).to have_title('/p0')
    session.click_link 'other'
    expect(session).to have_title('/other')
    session.go_back
    expect(session).to have_title('/p0')
    expect(seen.select {|p, _| p == '/p0' }.map(&:last)).to eq(%w[none same-origin none])
  end
end
