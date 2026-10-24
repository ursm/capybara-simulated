# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# A module script's fetch is a CORS request (HTML "fetch a single module script"): its Fetch Metadata mode `cors`, and a
# module of another origin whose response no `Access-Control-Allow-Origin` allows no module — its script's `error` — as
# one that allows it loads; with the credentials mode its `crossorigin` says, a `*` allowing no credentialed one; and a
# body cached for one origin's request answering no other's.
RSpec.describe 'a module script', :https do
  include PollUntil

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin served in-process
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  let(:modes) { {} }
  let(:cookies) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      modes[env['PATH_INFO']] = env['HTTP_SEC_FETCH_MODE']
      cookies[env['PATH_INFO']] = env['HTTP_COOKIE']
      origin = env['HTTP_ORIGIN'].to_s
      js = ->(headers = {}) { [200, {'content-type' => 'text/javascript'}.merge(headers), ['window.ran = (window.ran || []).concat(1);']] }
      case env['PATH_INFO']
      when '/same.mjs', '/denied.mjs' then js.()
      when '/allowed.mjs', '/star.mjs' then js.({'access-control-allow-origin' => '*'})
      when '/cred.mjs' then js.({'access-control-allow-origin' => origin, 'access-control-allow-credentials' => 'true'})
      when '/cached.mjs' then js.({'access-control-allow-origin' => 'https://www.example.com', 'cache-control' => 'max-age=3600'})
      when '/cookie' then [200, {'set-cookie' => 'k=v; SameSite=None; Secure; Path=/'}, ['']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']]
      end
    })
  end

  it 'is fetched as a CORS request, refused where another origin allows it none' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      for (const src of ['/same.mjs', 'https://other.example.com/denied.mjs', 'https://other.example.com/allowed.mjs']) {
        const s = document.createElement('script');
        s.type = 'module';
        s.src = src;
        s.onload = () => events.push(`load ${src}`);
        s.onerror = () => events.push(`error ${src}`);
        document.head.append(s);
      }
    JS
    expect(poll_until { session.evaluate_script('events.length') == 3 && session.evaluate_script('events.sort()') }).to eq(
      ['error https://other.example.com/denied.mjs', 'load /same.mjs', 'load https://other.example.com/allowed.mjs']
    )
    expect(modes.slice('/same.mjs', '/denied.mjs', '/allowed.mjs').values.uniq).to eq(['cors'])
  end

  it 'is fetched with its crossorigin credentials, and cached for its origin alone' do
    session.visit 'https://other.example.com/cookie'
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      for (const src of ['https://other.example.com/cred.mjs', 'https://other.example.com/star.mjs', 'https://other.example.com/cached.mjs']) {
        const s = document.createElement('script');
        s.type = 'module';
        s.crossOrigin = src.endsWith('cached.mjs') ? 'anonymous' : 'use-credentials';
        s.src = src;
        s.onload = () => events.push(`load ${src.split('/').pop()}`);
        s.onerror = () => events.push(`error ${src.split('/').pop()}`);
        document.head.append(s);
      }
    JS
    expect(poll_until { session.evaluate_script('events.length') == 3 && session.evaluate_script('events.sort()') }).to eq(['load cached.mjs', 'load cred.mjs', 'error star.mjs'].sort)
    expect(cookies['/cred.mjs']).to eq('k=v')
    # (…the cached body, allowed for www.example.com, none to a page of another origin)
    session.visit 'https://third.example.com/'
    session.execute_script(<<~JS)
      window.events = [];
      const s = document.createElement('script');
      s.type = 'module';
      s.src = 'https://other.example.com/cached.mjs';
      s.onload = () => events.push('load');
      s.onerror = () => events.push('error');
      document.head.append(s);
    JS
    expect(poll_until { session.evaluate_script('events.length') == 1 && session.evaluate_script('events') }).to eq(['error'])
  end
end
