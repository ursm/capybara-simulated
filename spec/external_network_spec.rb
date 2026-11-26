require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

Capybara.register_driver(:simulated_external_network) {|app| Capybara::Simulated::Driver.new(app, external_network: true) }

# Nothing goes to the network by default (Browser#dispatched): a request of a host the app does not serve — any kind — is
# a network error, as a browser's is where the network refuses it, and the app is never asked for it. `external_network:
# true` lets such requests go out, the app answering where the network refuses them.
RSpec.describe 'a request of a host the app does not serve' do
  let(:requests) { [] }
  let(:app) {
    log = requests
    lambda do |env|
      log << "#{env['SERVER_NAME']}#{env['PATH_INFO']}"
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><title>app</title><p>app']]
    end
  }
  let(:subresources) { <<~JS }
    const d = arguments[0]; const out = {};
    const i = new Image(); i.onload = () => out.img = 'load'; i.onerror = () => out.img = 'error'; i.src = 'http://outside.test/i.png';
    fetch('http://outside.test/f', {mode: 'no-cors'}).then(() => out.fetch = 'ok', (e) => out.fetch = e.name);
    const ws = new WebSocket('ws://outside.test/ws'); ws.onerror = () => out.ws = 'error'; ws.onopen = () => out.ws = 'open';
    const es = new EventSource('http://outside.test/es'); es.onerror = () => { out.es = 'error'; es.close(); };
    const s = document.createElement('script'); s.src = 'http://outside.test/s.js';
    s.onerror = () => out.script = 'error'; s.onload = () => out.script = 'load'; document.head.append(s);
    setTimeout(() => d(out), 300);
  JS

  context 'by default' do
    let(:session) { simulated_session(app) }

    it "commits the network-error document of a visit, the app never asked" do
      session.visit 'http://outside.test/x'
      expect([session.current_url, session.status_code, session.title]).to eq(['http://outside.test/x', 0, ''])
      expect(requests).to eq([])
    end

    it 'fails every subresource kind as a network error' do
      session.visit 'http://www.example.com/'
      expect(session.evaluate_async_script(subresources)).to eq(
        'img' => 'error', 'fetch' => 'TypeError', 'ws' => 'error', 'es' => 'error', 'script' => 'error'
      )
      expect(requests).to eq(['www.example.com/'])
    end
  end

  # (…the WPT runner's mode, which serves every host in-process: all of them the app's)
  context 'with every host served in-process', :every_host_local do
    let(:session) { simulated_session(app) }

    it 'asks the app' do
      session.visit 'http://outside.test/x'
      expect(session.title).to eq('app')
      expect(requests).to eq(['outside.test/x'])
    end
  end

  context 'with the network allowed' do
    let(:session) { simulated_session(app, mode: :simulated_external_network) }

    it 'goes to the network, and to the app where the network refuses it' do
      fetched = []
      allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch) {|_, url, *| fetched << url.to_s; nil }
      session.visit 'http://outside.test/x'
      expect(session.title).to eq('app')
      session.visit 'http://www.example.com/'
      expect(session.evaluate_async_script(subresources)).to include('fetch' => 'ok', 'script' => 'load')
      expect(fetched).to include('http://outside.test/x', 'http://outside.test/i.png', 'http://outside.test/f')
    end
  end
end
