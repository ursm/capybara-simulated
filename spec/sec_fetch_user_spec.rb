# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# A navigation's request carries `Sec-Fetch-User: ?1` where its source document had transient activation as it began
# (HTML's source snapshot params, which the request's user-activation is of) — and one no document began, the address
# bar's, always: a page's script navigating with no activation sends none, and one its user's click ran sends it — the
# page's, a frame's, and a window's its opener activated navigates.
RSpec.describe 'Sec-Fetch-User', :https do
  include PollUntil

  let(:seen) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = env['HTTP_SEC_FETCH_USER']
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8>
        <button id=top onclick="location.href = '/clicked'">top</button>
        <button id=frame onclick="frames[0].location.href = '/frame-clicked'">frame</button>
        <button id=pop onclick="w.location = '/pop-clicked'">pop</button>
        <a href="/linked">link</a>
        <form action="/got"><button>get</button></form>
        <form action="/posted" method=post><button>post</button></form>
        <button id=src onclick="frames[0].frameElement.src = '/src-clicked'">src</button>
        <button id=other onclick="o.location = '/other-clicked'">other</button>
        <iframe src="/blank"></iframe>
        <script>window.w = open('', 'pop')</script>
      HTML
    })
  end

  it 'is sent for an activated navigation and the address bar alone' do
    session.visit '/'
    expect(seen['/']).to eq('?1')
    # (…none for a script's that no user's action ran)
    session.execute_script("frames[0].location.href = '/frame-scripted'")
    expect(poll_until { seen.key?('/frame-scripted') }).to be(true)
    session.execute_script("location.href = '/scripted'")
    expect(poll_until { seen.key?('/scripted') }).to be(true)
    expect(seen.values_at('/frame-scripted', '/scripted')).to eq([nil, nil])
    session.visit '/'
    session.click_button 'frame'
    expect(poll_until { seen['/frame-clicked'] }).to eq('?1')
    session.click_button 'pop'
    expect(poll_until { seen['/pop-clicked'] }).to eq('?1')
    session.click_button 'top'
    expect(poll_until { seen['/clicked'] }).to eq('?1')
  end

  it "is sent for a link followed, a form submitted and a frame's src a click set" do
    session.visit '/'
    session.click_button 'src'
    expect(poll_until { seen['/src-clicked'] }).to eq('?1')
    session.click_link 'link'
    expect(poll_until { seen['/linked'] }).to eq('?1')
    session.visit '/'
    session.click_button 'get'
    expect(poll_until { seen['/got'] }).to eq('?1')
    session.visit '/'
    session.click_button 'post'
    expect(poll_until { seen['/posted'] }).to eq('?1')
  end

  # (…a window of a browser of its own, which its opener's click navigates)
  it 'is sent for a window another window navigates as it is activated' do
    session.visit '/'
    session.execute_script("window.o = open('/other', 'other')")
    expect(poll_until { seen.key?('/other') }).to be(true)
    session.click_button 'other'
    expect(poll_until { seen['/other-clicked'] }).to eq('?1')
  end
end
