# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# An image a rendered element's style uses is fetched at the rendering update that renders it — a page with nothing else
# to run is stepped for it (timers.rs `realmPending`), the restyle that owed it a task's or a script's read's — its
# `css` Resource Timing entry recorded. (Its request is no-cors, credentials `include`: CSS Values 4 "fetch a style
# resource".) And a document that lost its root since owes it no more.
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
  let(:cookies) { {} }   # (…what each path was requested with: that it was requested)
  let(:session) do
    simulated_session(lambda {|env|
      cookies[env['PATH_INFO']] = env['HTTP_COOKIE']
      case env['PATH_INFO']
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

  it 'is fetched on a page with nothing else to run' do
    session.visit '/'
    # (…its restyle a script's read's, which wakes the loop, and the page stepped as the driver goes on asking it)
    expect(poll_until { session.evaluate_script('document.body.offsetHeight') && cookies.key?('/bg.png') }).to be(true)
    css = session.evaluate_script("performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'css').map((e) => e.name)")
    expect(css).to eq(['https://other.example.com/bg.png'])
  end

  it 'leaves a page that lost its root settled' do
    session.visit '/'
    session.execute_script('document.body.offsetHeight; document.documentElement.remove()')
    expect(poll_until { !session.evaluate_script('__dom.realmPending(null, true)') }).to be(true)
  end
end
