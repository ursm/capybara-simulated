# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# The `Accept` a request carries where its header list has none: its destination's (Fetch "fetch" step 12) — an
# image's image types, a sheet's CSS, a frame's documents (a form's navigation of one too), and `*/*` for every other: a
# script's, a font's, a media resource's, a worker's — and a fetch()'s or an XHR's, of no destination; a prefetch's a
# document's, its initiator saying so before its destination does.
RSpec.describe 'a subresource request' do
  include PollUntil

  let(:seen) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = env['HTTP_ACCEPT']
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8>
        <link rel=stylesheet href=/s.css><script src=/c.js></script>
        <style>@font-face { font-family: F; src: url(/f.woff); } p { font-family: F; background: url(/bg.png); }</style><p>x</p>
        <img src=/i.png><video src=/v.mp4 poster=/poster.png></video><audio src=/a.mp3></audio><iframe src=/frame></iframe>
        <link rel=prefetch href=/prefetch><iframe name=target></iframe>
        <form target=target action=/form></form>
        <script>document.forms[0].submit(); fetch('/fetch'); const x = new XMLHttpRequest(); x.open('GET', '/xhr'); x.send(); new Worker('/w.js');</script>
      HTML
      when '/s.css' then [200, {'content-type' => 'text/css'}, ['']]
      when '/c.js', '/w.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      else [200, {'content-type' => 'text/plain'}, ['']]
      end
    })
  end

  it "carries its destination's Accept" do
    session.visit '/'
    documents = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    expect(poll_until { seen.size >= 15 && seen }).to eq(
      '/'           => documents,
      '/s.css'      => 'text/css,*/*;q=0.1',
      '/c.js'       => '*/*',
      '/f.woff'     => '*/*',
      '/bg.png'     => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      '/i.png'      => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      '/poster.png' => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      '/v.mp4'      => '*/*',
      '/a.mp3'      => '*/*',
      '/frame'      => documents,
      '/form'       => documents,
      '/prefetch'   => documents,
      '/fetch'      => '*/*',
      '/xhr'        => '*/*',
      '/w.js'       => '*/*'
    )
  end

  # (…and the network's leg of a service worker's race against its handler, the request the worker was handed: a frame
  # navigation's a document's, an image's image types)
  # (…a service worker modeled in a universal-server context alone)
  it "races a service worker's handler with the request's Accept", :every_host_local do
    races = {}
    session = simulated_session(lambda {|env|
      races[env['PATH_INFO']] = env['HTTP_ACCEPT'] if env['PATH_INFO'].start_with?('/race')
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [<<~JS]]
        self.addEventListener('install', (e) => {
          e.addRoutes({ condition: { urlPattern: new URLPattern({ pathname: '/race*' }) }, source: 'race-network-and-fetch-handler' });
        });
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', () => {});
      JS
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']]
      end
    })
    session.visit '/'
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      navigator.serviceWorker.register('/sw.js', {scope: '/'}).then(() => navigator.serviceWorker.ready).then(() => done(), (e) => done(e.name));
    JS
    session.visit '/'
    session.execute_script(<<~JS)
      const frame = document.createElement('iframe');
      frame.src = '/race-frame';
      document.body.append(frame, Object.assign(new Image(), {src: '/race.png'}));
    JS
    expect(poll_until { session.evaluate_script('1') && races.size >= 2 && races }).to eq(
      '/race-frame' => 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '/race.png'   => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5'
    )
  end
end
