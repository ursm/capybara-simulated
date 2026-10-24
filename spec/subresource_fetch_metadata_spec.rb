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
  let(:seen_site) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_DEST'], env['HTTP_SEC_FETCH_MODE']]
      seen_site[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_SITE'], env['HTTP_REFERER']]
      case env['PATH_INFO']
      when '/w.js', '/sw.js' then [200, {'content-type' => 'text/javascript'}, ["importScripts('/i.js'); postMessage(1);"]]
      when '/i.js', '/m2.js', '/d3.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      when '/mw.js' then [200, {'content-type' => 'text/javascript'}, ["import './m2.js'; import('./d2.js');"]]
      when '/d2.js' then [200, {'content-type' => 'text/javascript'}, ["import './d3.js';"]]
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

  # (…and a worker's import of its own: the worker the client, an opaque one's site cross-site, its URL no referrer)
  it "sends a data: worker's import as its own" do
    session.visit '/'
    session.execute_script(%q{new Worker('data:text/javascript,importScripts("' + location.origin + '/i.js")')})
    expect(poll_until { seen['/i.js'] }).to eq(%w[script no-cors])
    expect(seen_site['/i.js']).to eq(['cross-site', nil])
  end

  # (…a module worker's graph of its destination, an `import()` and what that imports a script's)
  it "fetches a module worker's graph as the worker, its import() as a script" do
    session.visit '/'
    session.execute_script("new Worker('/mw.js', {type: 'module'})")
    expect(poll_until { seen['/d3.js'] && seen.slice('/mw.js', '/m2.js', '/d2.js', '/d3.js') }).to eq(
      '/mw.js' => %w[worker same-origin],
      '/m2.js' => %w[worker cors],
      '/d2.js' => %w[script cors],
      '/d3.js' => %w[script cors]
    )
  end

  it 'refuses a beacon over the keepalive quota' do
    session.visit '/'
    expect(session.evaluate_script("['x'.repeat(70000), 'x'.repeat(40000)].map((d, i) => navigator.sendBeacon('/q' + i, d))")).to eq([false, true])
  end
end
