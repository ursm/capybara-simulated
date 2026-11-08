# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An entry's document made again — a traversal's, a reload's — is made of its document state (HTML "apply the history
# step"): the request referrer and its policy the navigation that made the entry set once — a redirect that makes its
# request a GET drops its POST body, not its referrer (Fetch "HTTP-redirect fetch"), and a reload of it changes none of
# it — and its classic history API state, but none where a redirect or another origin made the document anew (HTML
# "create navigation params by fetching", afterDocumentPopulated `oldOrigin`), the page's and a frame's alike.
# Measured 2026-11-08: back to a Post/Redirect/Get page sends the form page's URL (Chrome 157's frame, Firefox 159's page
# and frame); a reload keeps `history.state` (both, a frame's), one redirected none (both, the page's), and a frame's
# traversal back to an entry whose response now sandboxes it none (Chrome; Firefox keeps it — the text over it).
RSpec.describe 'a session history entry made again' do
  include PollUntil

  let(:seen) { [] }
  let(:count) { Hash.new(0) }
  let(:session) do
    simulated_session(lambda {|env|
      seen << [env['REQUEST_METHOD'], env['PATH_INFO'], env['HTTP_REFERER']] unless env['PATH_INFO'] == '/favicon.ico'
      n = (count[env['PATH_INFO']] += 1)
      html = ->(body, headers = {}) { [200, {'content-type' => 'text/html; charset=utf-8'}.merge(headers), ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/form' then html.('<title>form</title><form method=post action=/post><input name=a value=b><button>go</button></form>')
      when '/post' then [303, {'location' => '/done'}, []]
      when '/top' then html.("<iframe name=f src=/f1></iframe><script>addEventListener('message', (e) => { window.said = e.data })</script>")
      when '/f1' then html.('<title>f1</title><a href=/f2>f2</a>')
      when '/moves' then n > 1 ? [302, {'location' => '/moved'}, []] : html.('<title>moves</title>')
      when '/sandboxes'
        said = "<script>parent.postMessage(JSON.stringify(history.state) + ' ' + origin, '*')</script>"
        n > 1 ? html.(said, {'content-security-policy' => 'sandbox allow-scripts'}) : html.('<title>sandboxes</title><a href=/other>other</a>')
      else html.("<title>#{env['PATH_INFO']}</title><a href=/other>other</a>")
      end
    })
  end

  def requests_of(path) = seen.select {|_, p, _| p == path }
  def frame_title = session.evaluate_script('frames[0].document.title')

  it "refers a traversal back to a Post/Redirect/Get page by the form's page" do
    session.visit '/form'
    session.click_button 'go'
    expect(session).to have_title('/done')
    session.click_link 'other'
    expect(session).to have_title('/other')
    session.go_back
    expect(session).to have_title('/done')
    expect(requests_of('/done').map(&:last)).to eq(['http://www.example.com/form'] * 2)
  end

  it "keeps a frame's entry's request through a reload of its document" do
    session.visit '/top'
    session.within_frame('f') { session.click_link 'f2' }
    expect(poll_until { frame_title == '/f2' }).to be(true)
    session.execute_script('frames[0].location.reload()')
    expect(poll_until { requests_of('/f2').size == 2 }).to be(true)
    session.within_frame('f') { session.click_link 'other' }
    expect(poll_until { frame_title == '/other' }).to be(true)
    session.execute_script('history.back()')
    expect(poll_until { requests_of('/f2').size == 3 }).to be(true)
    expect(requests_of('/f2').last.last).to eq('http://www.example.com/f1')
  end

  it "gives a frame's reloaded document its entry's state" do
    session.visit '/top'
    session.execute_script("frames[0].history.replaceState({k: 2}, '')")
    session.execute_script('frames[0].location.reload()')
    expect(poll_until { requests_of('/f1').size == 2 && frame_title == 'f1' }).to be(true)
    expect(session.evaluate_script('frames[0].history.state')).to eq('k' => 2)
  end

  it "gives none to a page's document a reload's redirect made" do
    session.visit '/moves'
    session.execute_script("history.replaceState({k: 1}, '')")
    session.refresh
    expect(session).to have_title('/moved')
    expect(session.evaluate_script('history.state')).to be_nil
  end

  it "gives none to a frame's document a traversal back made of another origin" do
    session.visit '/top'
    session.execute_script("frames[0].location = '/sandboxes'")
    expect(poll_until { frame_title == 'sandboxes' }).to be(true)
    session.execute_script("frames[0].history.replaceState({k: 3}, '')")
    session.within_frame('f') { session.click_link 'other' }
    expect(poll_until { frame_title == '/other' }).to be(true)
    session.execute_script('history.back()')
    expect(poll_until { session.evaluate_script('window.said') }).to eq('null null')
  end
end
