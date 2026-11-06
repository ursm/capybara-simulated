require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# `isSecureContext` (HTML "is a secure context"), the one rule cross-origin opener policies and a service worker's control
# read (url_ops.rs `secure_top_level`), and the driver's default host: under Capybara's default configuration it visits at
# `http://www.example.com` as the stand-in for the app's own server on 127.0.0.1, where a user's browser is in a secure
# context (`Browser.default_host`). A host asked for by name, or by `app_host`, is the origin it says.
RSpec.describe 'a secure context' do
  let(:coi) { {'content-type' => 'text/html', 'cross-origin-opener-policy' => 'same-origin', 'cross-origin-embedder-policy' => 'require-corp'} }
  let(:app) {
    headers = coi
    lambda {|env|
      case env['PATH_INFO']
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ['postMessage(isSecureContext)']]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<p>frame</p>']]
      else [200, headers, ['<!doctype html><iframe name="fr" src="/frame"></iframe>']]
      end
    }
  }
  let(:session) { simulated_session(app) }
  after { session.reset_session! }

  def from_worker = session.evaluate_async_script("const w = new Worker('/w.js'); w.onmessage = (e) => arguments[0](e.data)")

  it 'is the default host, cross-origin isolated by its headers, and its frame and worker with it' do
    session.visit('/')
    expect(session.evaluate_script('[location.origin, isSecureContext, crossOriginIsolated, typeof SharedArrayBuffer]')).to eq(['http://www.example.com', true, true, 'function'])
    session.within_frame('fr') { expect(session.evaluate_script('isSecureContext')).to be(true) }
    expect(from_worker).to be(true)
  end

  it 'is no host of no trust, its frame and worker none either', :every_host_local do
    session.visit('http://a.test/')
    expect(session.evaluate_script('[isSecureContext, crossOriginIsolated]')).to eq([false, false])
    session.within_frame('fr') { expect(session.evaluate_script('isSecureContext')).to be(false) }
    expect(from_worker).to be(false)
  end

  it 'is https and loopback', :every_host_local do
    ['https://a.test/', 'http://127.0.0.1/', 'http://localhost/'].each do |url|
      session.visit(url)
      expect(session.evaluate_script('[location.href, isSecureContext]')).to eq([url, true])
    end
  end

  # (…no stand-in where a suite names the same host itself)
  it 'is not `http://www.example.com` where `app_host` names it' do
    previous = Capybara.app_host
    Capybara.app_host = 'http://www.example.com'
    begin
      explicit = simulated_session(app)
      explicit.visit('/')
      expect(explicit.evaluate_script('[isSecureContext, crossOriginIsolated]')).to eq([false, false])
    ensure
      Capybara.app_host = previous
    end
  end
end
