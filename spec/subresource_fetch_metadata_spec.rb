# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# The destination and mode a subresource's request reports in its Fetch Metadata (Fetch Metadata Request Headers): a
# font's `font` (CSS Fonts 4 §4.9.1, a CORS request), a worker's script `worker` / `sharedworker` (HTML "fetch a classic
# worker script"), a script it imports `script` ("fetch a classic worker-imported script"), and a beacon's mode
# "no-cors" unless its body's Content-Type is no CORS-safelisted one (Beacon "sendBeacon").
RSpec.describe 'a subresource request', :https do
  include PollUntil

  let(:seen) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_DEST'], env['HTTP_SEC_FETCH_MODE']]
      case env['PATH_INFO']
      when '/w.js', '/sw.js' then [200, {'content-type' => 'text/javascript'}, ["importScripts('/i.js'); postMessage(1);"]]
      when '/i.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      when '/f.woff' then [404, {}, ['']]
      else [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8>
        <style>@font-face { font-family: F; src: url(/f.woff); } p { font-family: F; }</style><p>x</p>
      HTML
      end
    })
  end

  it 'reports its destination and mode' do
    session.visit '/'
    session.execute_script(<<~JS)
      document.fonts.load('16px F');
      new Worker('/w.js');
      new SharedWorker('/sw.js');
      navigator.sendBeacon('/plain', 'x');
      navigator.sendBeacon('/json', new Blob(['{}'], {type: 'application/json'}));
    JS
    expect(poll_until { seen.size >= 7 && seen.except('/') }).to eq(
      '/f.woff' => %w[font cors],
      '/w.js'   => %w[worker same-origin],
      '/sw.js'  => %w[sharedworker same-origin],
      '/i.js'   => %w[script no-cors],
      '/plain'  => %w[empty no-cors],
      '/json'   => %w[empty cors]
    )
  end
end
