# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# The `Accept` a request carries where its header list has none: its destination's (Fetch "fetch" step 12) — an
# image's image types, a sheet's CSS, a frame's documents, and `*/*` for every other: a script's, a font's, a media
# resource's, a worker's — and a fetch()'s or an XHR's, of no destination.
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
        <script>fetch('/fetch'); const x = new XMLHttpRequest(); x.open('GET', '/xhr'); x.send(); new Worker('/w.js');</script>
      HTML
      when '/s.css' then [200, {'content-type' => 'text/css'}, ['']]
      when '/c.js', '/w.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      else [200, {'content-type' => 'text/plain'}, ['']]
      end
    })
  end

  it "carries its destination's Accept" do
    session.visit '/'
    expect(poll_until { seen.size >= 13 && seen.except('/') }).to eq(
      '/s.css'      => 'text/css,*/*;q=0.1',
      '/c.js'       => '*/*',
      '/f.woff'     => '*/*',
      '/bg.png'     => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      '/i.png'      => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      '/poster.png' => 'image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      '/v.mp4'      => '*/*',
      '/a.mp3'      => '*/*',
      '/frame'      => 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '/fetch'      => '*/*',
      '/xhr'        => '*/*',
      '/w.js'       => '*/*'
    )
  end
end
