# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A link's `integrity` is its request's integrity metadata (HTML "create link options from element"), whatever the
# link's type, and a response that does not match it is a network error (Fetch "main fetch", SRI "does response match
# metadataList?"): the link's `error`, no sheet made of it — a preload's of any destination, its consumer taking that
# network error. Chrome and Firefox: the sheet's and the style preload's `error`, the sheet not applied; both take an
# image preload's response whatever its integrity, which the spec does not.
RSpec.describe 'link integrity' do
  include PollUntil

  CSS = 'p { color: red }'
  GOOD = "sha256-#{Digest::SHA256.base64digest(CSS)}".freeze
  BAD = "sha256-#{'A' * 43}=".freeze

  it 'loads a link whose response matches its integrity and refuses one that does not' do
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/css'}, [CSS]] if env['PATH_INFO'] == '/s.css'
      next [200, {'content-type' => 'image/png'}, [File.binread(File.expand_path('wpt/resource-timing/resources/blue.png', __dir__))]] if env['PATH_INFO'] == '/i.png'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><p>p</p>']]
    }).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      window.events = [];
      for (const [rel, as, href, integrity] of [['stylesheet', '', '/s.css?bad', '#{BAD}'], ['preload', 'style', '/s.css?pre', '#{BAD}'],
                                                ['preload', 'image', '/i.png', '#{BAD}'], ['preload', 'style', '/s.css?good', '#{GOOD}']]) {
        const link = Object.assign(document.createElement('link'), { rel, href, integrity });
        if (as) link.as = as;
        link.onload = () => events.push(href + ':load');
        link.onerror = () => events.push(href + ':error');
        document.head.append(link);
      }
    JS
    expect(poll_until { s.evaluate_script('events.length === 4') }).to be true
    expect(s.evaluate_script("[events.sort(), getComputedStyle(document.querySelector('p')).color]")).to eq([
      ['/i.png:error', '/s.css?bad:error', '/s.css?good:load', '/s.css?pre:error'], 'rgb(0, 0, 0)'
    ])
    s.execute_script("document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/s.css?good', integrity: '#{GOOD}' }))")
    expect(poll_until { s.evaluate_script("getComputedStyle(document.querySelector('p')).color === 'rgb(255, 0, 0)'") }).to be true
  end
end
