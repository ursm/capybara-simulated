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
  # …and referred by the sheet that declared it (CSS Values 4 "fetch a style resource": its style resource's location) —
  # a linked sheet's and an imported one's by its own URL — or, declared by no located sheet (a `<style>`, an inline
  # `style`), by its document.
  it 'is referred by the sheet that declared it' do
    referers = {}
    s = simulated_session(lambda {|env|
      referers[env['PATH_INFO']] = env['HTTP_REFERER']
      case env['PATH_INFO']
      when '/l.css' then [200, {'content-type' => 'text/css'}, ['@import url(/i.css); #a { background-image: url(/a.png) }']]
      when '/i.css' then [200, {'content-type' => 'text/css'}, ['#b { background-image: url(/b.png) }']]
      when %r{\A/[a-d]\.png\z} then [200, {'content-type' => 'image/png'}, [File.binread(File.expand_path('wpt/common/square.png', __dir__))]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><link rel=stylesheet href="/l.css"><style>#c { background-image: url(/c.png) }</style>
          <div id=a style="width:9px;height:9px"></div><div id=b style="width:9px;height:9px"></div><div id=c style="width:9px;height:9px"></div>
          <div style="width:9px;height:9px;background-image:url(/d.png)"></div>
        HTML
      end
    })
    s.visit '/'
    expect(poll_until { s.evaluate_script('document.body.offsetHeight') && (got = referers.slice('/a.png', '/b.png', '/c.png', '/d.png')).size == 4 && got }).to eq(
      '/a.png' => 'https://www.example.com/l.css', '/b.png' => 'https://www.example.com/i.css',
      '/c.png' => 'https://www.example.com/', '/d.png' => 'https://www.example.com/'
    )
  end
end

