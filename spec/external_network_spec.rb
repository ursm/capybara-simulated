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

  context 'with some hosts allowed' do
    let(:session) {
      Capybara.register_driver(:simulated_some_network) {|a| Capybara::Simulated::Driver.new(a, external_network: ['allowed.test', 'localhost:4020']) }
      simulated_session(app, mode: :simulated_some_network)
    }

    it 'sends those alone to the network' do
      fetched = []
      allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch) {|_, url, *| fetched << url.to_s; nil }
      session.visit 'http://www.example.com/'
      session.evaluate_async_script(<<~JS)
        const d = arguments[0];
        const urls = ['http://allowed.test/a', 'http://localhost:4020/b', 'http://localhost:4021/c', 'http://outside.test/d'];
        Promise.all(urls.map((u) => fetch(u, {mode: 'no-cors'}).catch(() => 0))).then(() => d(1));
      JS
      expect(fetched).to eq(['http://allowed.test/a', 'http://localhost:4020/b'])
    end
  end

  # The app's host as Capybara has it as each request is made: a test sets `Capybara.app_host` whenever it likes (a tenant's
  # subdomain), the session's Browser made long before.
  context 'as the app host changes' do
    let(:session) { simulated_session(app) }

    after { Capybara.app_host = nil }

    it "follows Capybara.app_host" do
      session.visit '/'
      Capybara.app_host = 'http://tenant1.lvh.test'
      session.visit '/'
      expect([session.current_url, session.title]).to eq(['http://tenant1.lvh.test/', 'app'])
      Capybara.app_host = 'http://other.test:3000'
      session.reset!
      session.visit '/x'
      expect([session.current_url, session.title]).to eq(['http://other.test:3000/x', 'app'])
    end
  end

  # A loopback name at the server's port reaches the app's own server, whatever stands in for it (a mailer's link).
  context 'on a loopback name at the server port' do
    let(:session) { simulated_session(app) }

    around do |example|
      port = Capybara.server_port
      Capybara.server_port = 4567
      example.run
    ensure
      Capybara.server_port = port
    end

    it 'asks the app, another port not' do
      %w[http://127.0.0.1:4567/a http://localhost:4567/a http://[::1]:4567/a].each do |url|
        session.visit url
        expect(session.title).to eq('app')
      end
      session.visit 'http://localhost:4568/a'
      expect(session.title).to eq('')
    end
  end

  # A response an allowing session stored is the network's, which a refusing one does not get from the cache either.
  it "serves no stored response of another host to a session that refuses it" do
    Capybara.register_driver(:simulated_external_network) {|a| Capybara::Simulated::Driver.new(a, external_network: true) }
    script = [200, {'content-type' => 'text/javascript', 'cache-control' => 'max-age=31536000, immutable'}, ['window.ran = true']]
    allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch).and_return(script)
    load = "const d = arguments[0]; const s = document.createElement('script'); s.src = 'http://cdn.test/cached.js'; s.onload = () => d('load'); s.onerror = () => d('error'); document.head.append(s);"
    open = simulated_session(app, mode: :simulated_external_network)
    open.visit 'http://www.example.com/'
    expect(open.evaluate_async_script(load)).to eq('load')
    shut = simulated_session(app)
    shut.visit 'http://www.example.com/'
    expect(shut.evaluate_async_script(load)).to eq('error')
  end

  # (…an IPv6 server host bracketed in the URL the app is reached at, and a secure WebSocket's default port 443)
  it 'brackets an IPv6 server host and takes wss: to port 443' do
    host, port = Capybara.server_host, Capybara.server_port
    Capybara.server_host, Capybara.server_port = '::1', 4567
    expect(Capybara::Simulated::Browser.default_host).to eq('http://[::1]:4567')
  ensure
    Capybara.server_host, Capybara.server_port = host, port
  end

  it 'takes ws: to port 80 and wss: to 443' do
    browser = Capybara::Simulated::Browser.allocate
    ports = %w[ws://a.test/ wss://a.test/ http://a.test/ https://a.test/].map {|u| browser.send(:effective_port, browser.send(:parse_url, u)) }
    expect(ports).to eq([80, 443, 80, 443])
  end
end
