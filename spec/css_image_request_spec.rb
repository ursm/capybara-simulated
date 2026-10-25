# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# An image a rendered element's style uses is fetched at the rendering update that renders it — a page with nothing else
# to run is stepped for it (timers.rs `realmPending`) — its `css` Resource Timing entry recorded, and its request is
# Fetch's for one (CSS Values 4 "fetch a style resource"): no-cors, credentials `include`, another origin's cookies sent
# with it, as with an `<img>` of no `crossorigin`.
RSpec.describe 'an image a style sheet references', :https do
  include PollUntil

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin served in-process
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  png = File.binread(File.expand_path('wpt/common/square.png', __dir__))
  let(:cookies) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      cookies[env['PATH_INFO']] = env['HTTP_COOKIE']
      case env['PATH_INFO']
      when '/cookie' then [200, {'set-cookie' => 'k=v; SameSite=None; Secure; Path=/'}, ['']]
      when '/bg.png', '/img.png' then [200, {'content-type' => 'image/png'}, [png]]
      else
        page = <<~HTML
          <!DOCTYPE html><meta charset="utf-8">
          <div style="width:10px;height:10px;background-image:url(https://other.example.com/bg.png)"></div>
          <img src="https://other.example.com/img.png">
        HTML
        [200, {'content-type' => 'text/html'}, [page]]
      end
    })
  end

  it 'is fetched on a page with nothing else to run, with another origin\'s cookies' do
    session.visit 'https://other.example.com/cookie'
    session.visit '/'
    # (…the page's rendering updates run as the driver asks it something: a CSS image is fetched at one)
    expect(poll_until { session.evaluate_script('document.body.offsetHeight') && cookies.key?('/bg.png') && cookies.key?('/img.png') }).to be(true)
    expect(cookies.values_at('/bg.png', '/img.png')).to eq(%w[k=v k=v])
    css = session.evaluate_script("performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'css').map((e) => e.name)")
    expect(css).to eq(['https://other.example.com/bg.png'])
  end
end
