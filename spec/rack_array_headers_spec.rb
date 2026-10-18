# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A Rack 3 app may give a header as an Array of its fields; the driver's own reads of a response's headers — CORS's,
# a preflight's, a download's, the response's type, the HTTP cache's, Basic authentication's — take them combined with
# ", " as a browser builds the header list (AssetCache.combined, Browser#header_text), where they had read the Array's
# `inspect` or its first field; and a Location of more than one field is none to follow.
RSpec.describe 'a response header given as an Array' do
  it 'is read as its fields combined, by CORS and a preflight' do
    app = lambda {|env|
      cors = {'access-control-allow-origin' => ['*'], 'access-control-allow-headers' => ['x-a', 'x-b'], 'access-control-allow-methods' => ['PUT']}
      case env['PATH_INFO']
      when '/data' then [200, {'content-type' => ['text/plain']}.merge(cors), ['cross']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      fetch('http://other.example.com/data', { method: 'PUT', headers: { 'x-b': '1' } })
        .then((r) => r.text(), (e) => e.name).then((t) => { window.got = t; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq('cross')
  end

  it 'is read so by the HTTP cache, Basic authentication and a redirect' do
    hits = Hash.new(0)
    app = lambda {|env|
      path = env['PATH_INFO']
      hits[path] += 1
      case path
      when '/nostore' then [200, {'cache-control' => ['no-store'], 'last-modified' => 'Mon, 01 Jan 2024 00:00:00 GMT'}, ["n=#{hits[path]}"]]
      when '/auth'
        next [200, {}, ['in']] if env['HTTP_AUTHORIZATION']
        [401, {'www-authenticate' => ['Basic realm="x"']}, ['no']]
      when '/two' then [302, {'location' => ['/a', '/b']}, ['']]
      when '/none' then [302, {'location' => [], 'content-type' => 'text/plain'}, ['three']]
      when '/a', '/b' then [200, {}, [path]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const read = (url, user) => { const x = new XMLHttpRequest(); try { x.open('GET', url, false, user, user && 'p'); x.send(); return x.status + ' ' + x.responseText; } catch (e) { return e.name; } };
        return [read('/nostore'), read('/nostore'), read('/auth', 'u'), read('/two'), read('/none')];
      })()
    JS
    expect(got).to eq(['200 n=1', '200 n=2', '200 in', 'NetworkError', '302 three'])
  end
end
