require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# What the app raises under a request of the page, as a browser run's stack has it. The driver stands for Puma and
# Capybara::Server::Middleware: every client gets Puma's 500, and the session raises the error where Capybara does,
# `Session#raise_server_error!` — `visit`, `refresh`, `reset!`, a failed `synchronize` — and nowhere else. Each row below measured
# with Capybara 3.40, Puma 8, Cuprite, Chrome 157 (`real/probe.rb`, reviewer's `p/r1/real2.rb`):
#   fetch('/raise')                 [500, false, nil, "Puma caught this error: of the app (ArgumentError)\n…"]
#   evaluate_script, passing find   return
#   a failing find                  raises ArgumentError, its cause a CapybaraError; the next find returns
#   visit('/raise')                 returns, status 500, its text the body; the next visit raises
#   reset_session!                  raises
#   raise_server_errors = false     500, nothing raised
#   NotImplementedError, LoadError, an Exception of the app's: the same
RSpec.describe 'an exception of the app under a request of the page' do
  include PollUntil

  stub_const_error = Class.new(Exception) # rubocop:disable Lint/InheritException
  let(:pass_through) { "self.addEventListener('install', () => skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));" }
  let(:app) {
    worker = pass_through
    lambda {|env|
      case env['PATH_INFO']
      when '/pass.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ["fetch('/raise').then((r) => postMessage(r.status), (e) => postMessage(e.name));"]]
      when '/raise', '/raise.js', '/raise.css', '/raise.png' then raise ArgumentError, 'of the app'
      when '/notimpl' then raise NotImplementedError, 'scripterr'
      when '/load' then raise LoadError, 'lazy'
      when '/hard' then raise stub_const_error, 'hard'
      when '/exit' then raise SystemExit
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><p id="p">x</p>']]
      end
    }
  }
  let(:session) { simulated_session(app) }
  after {
    begin
      session.reset_session!
    rescue Exception # rubocop:disable Lint/RescueException
      nil
    end
  }

  let(:read_response) { "const d = arguments[0]; fetch('%s').then((r) => r.text().then((b) => d([r.status, r.ok, r.headers.get('content-type'), b.split('\\n')[0]])), (e) => d(e.name))" }
  def fetch_raising(path = '/raise') = session.evaluate_async_script(format(read_response, path))
  def controlled
    session.visit('/')
    session.evaluate_async_script("const d = arguments[0]; navigator.serviceWorker.register('/pass.js').then(() => navigator.serviceWorker.ready).then(() => d())")
    expect(poll_until { session.evaluate_script('!!navigator.serviceWorker.controller') }).to be(true)
  end

  it 'answers Puma\'s 500, no Content-Type, its message and class first' do
    session.visit('/')
    expect(fetch_raising).to eq([500, false, nil, 'Puma caught this error: of the app (ArgumentError)'])
  end

  it 'raises nothing at a script, nor at a passing find' do
    session.visit('/')
    fetch_raising
    expect(session.evaluate_script('1')).to eq(1)
    session.execute_script('1')
    expect(session.html).to include('<p')
    expect(session.title).to eq('')
    expect(session).to have_css('#p')
    expect(session.find('#p').text).to eq('x')
  end

  it 'raises at a failing find, Capybara\'s words its cause, and once' do
    session.visit('/')
    fetch_raising
    expect { session.find('.none', wait: 0) }.to raise_error(ArgumentError, 'of the app') {|e| expect(e.cause).to be_a(Capybara::CapybaraError) }
    expect(session.find('#p').text).to eq('x')
  end

  it 'raises at the next visit' do
    session.visit('/')
    fetch_raising
    expect { session.visit('/') }.to raise_error(ArgumentError)
  end

  it 'raises at the next refresh' do
    session.visit('/')
    fetch_raising
    expect { session.refresh }.to raise_error(ArgumentError)
  end

  it 'raises at the reset, the session reset all the same' do
    session.visit('/')
    fetch_raising
    expect { session.reset_session! }.to raise_error(ArgumentError)
    expect(session.reset_session!).to be_nil
    expect(session.current_url.to_s).to eq('about:blank').or eq('')
  end

  it 'returns a visit of a route that raises, status 500, its text the body; the next visit raises' do
    session.visit('/raise')
    expect(session.status_code).to eq(500)
    expect(session.text).to start_with('Puma caught this error: of the app (ArgumentError)')
    expect { session.visit('/') }.to raise_error(ArgumentError, 'of the app')
  end

  it 'answers a synchronous XHR the 500' do
    session.visit('/')
    expect(session.evaluate_script("(() => { const x = new XMLHttpRequest(); x.open('GET', '/raise', false); x.send(); return x.status; })()")).to eq(500)
  end

  it 'answers a worker\'s fetch the 500, and raises it' do
    session.visit('/')
    expect(session.evaluate_async_script("const d = arguments[0]; new Worker('/w.js').onmessage = (e) => d(e.data);")).to eq(500)
    expect { session.visit('/') }.to raise_error(ArgumentError)
  end

  it 'answers a controlled page\'s visit and fetch the 500 through a service worker, and raises it' do
    controlled
    expect(fetch_raising).to eq([500, false, nil, 'Puma caught this error: of the app (ArgumentError)'])
    expect { session.visit('/') }.to raise_error(ArgumentError)
    session.visit('/raise')
    expect(session.status_code).to eq(500)
    expect { session.visit('/') }.to raise_error(ArgumentError)
  end

  it 'loads a frame of the 500\'s text, and fails an image, a script and a sheet' do
    session.visit('/')
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], out = {};
      const add = (tag, attr, url) => new Promise((resolve) => {
        const el = document.createElement(tag);
        if (tag === 'link') el.rel = 'stylesheet';
        el.onload = () => resolve(out[tag] = 'load');
        el.onerror = () => resolve(out[tag] = 'error');
        el[attr] = url;
        document.body.append(el);
      });
      Promise.all([add('img', 'src', '/raise.png'), add('script', 'src', '/raise.js'), add('link', 'href', '/raise.css'), add('iframe', 'src', '/raise')]).then(() => {
        out.frame = document.querySelector('iframe').contentDocument.body.textContent.split('\\n')[0];
        done(out);
      });
    JS
    expect(got).to eq('img' => 'error', 'script' => 'error', 'link' => 'error', 'iframe' => 'load', 'frame' => 'Puma caught this error: of the app (ArgumentError)')
    expect { session.visit('/') }.to raise_error(ArgumentError)
  end

  # (…`rescue *@server_errors`, of `[Exception]` by default: any class of the app's. Measured: each a 500, then raised at `visit`)
  {'/notimpl' => NotImplementedError, '/load' => LoadError, '/hard' => Exception}.each do |path, kind|
    it "records #{path}'s #{kind}, an exception of no StandardError" do
      session.visit('/')
      expect(fetch_raising(path)[0]).to eq(500)
      expect { session.visit('/') }.to raise_error(kind)
    end
  end

  # (…a process's or a thread's way out goes through: an `exit` in a page's request is no answer of the app's)
  it 'lets a SystemExit through' do
    session.visit('/')
    expect(session.driver.browser.send(:app_exception?, SystemExit.new)).to be(false)
    expect(session.driver.browser.send(:app_exception?, Interrupt.new)).to be(false)
    expect(session.driver.browser.send(:app_exception?, Capybara::Simulated::Browser.const_get(:EventSourceCancelled).new)).to be(false)
  end

  # What a browser's request would have reached the server by. Cuprite and Puma on port 18555, `host-resolver-rules` mapping every
  # name here (reviewer's `p/r1/sub.rb`): a name of the page's site, a page on a subdomain to its apex, and another name at that
  # port: 500, the next `visit` raises. Another port with no server, a CDN's name: TypeError, nothing raised. (Here the network
  # refuses all of them, and the app is asked for each: Forem's CDN script, `NOTOWN`.)
  describe 'a request off the page\'s own host' do
    before { allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch).and_return(nil) }

    def request_from(page, url)
      session.visit(page)
      session.evaluate_async_script("const d = arguments[0]; fetch(#{url.to_json}, {mode: 'no-cors'}).then((r) => d(r.type), (e) => d(e.name))")
    end

    [
      ['http://lvh.test:18555/', 'http://foo.lvh.test:18555/raise', :raises],
      ['http://foo.lvh.test:18555/', 'http://lvh.test:18555/raise', :raises],
      ['http://lvh.test:18555/', 'http://other.test:18555/raise', :raises],
      ['http://lvh.test/', 'http://foo.lvh.test/raise', :raises],
      ['http://lvh.test:18555/', 'http://lvh.test:18556/raise', :none],
      ['http://lvh.test:18555/', 'http://cdn.example.invalid/raise', :none],
      ['http://lvh.test/', 'http://cdn.example.invalid/raise', :none]
    ].each do |page, url, outcome|
      it "#{outcome == :raises ? 'raises' : 'raises nothing of'} #{url} from #{page}" do
        got = request_from(page, url)
        if outcome == :raises
          expect(got).not_to eq('TypeError')
          expect { session.visit(page) }.to raise_error(ArgumentError, 'of the app')
        else
          expect(got).to eq('TypeError')
          expect { session.visit(page) }.not_to raise_error
        end
      end
    end
  end

  # (…a Host, as every real request sends: a subdomain middleware reads the raw env)
  it 'tells the app the Host', :every_host_local do
    hosts = []
    s = simulated_session(lambda {|env|
      hosts << env['HTTP_HOST']
      [200, {'content-type' => 'text/html'}, ['<p>x</p>']]
    })
    s.visit('http://foo.lvh.test:18555/x')
    s.visit('http://lvh.test/x')
    s.visit('https://lvh.test/x')
    s.visit('https://lvh.test:444/x')
    expect(hosts).to eq(['foo.lvh.test:18555', 'lvh.test', 'lvh.test', 'lvh.test:444'])
  end

  describe 'Capybara\'s settings' do
    around do |example|
      # (…a copy: `server_errors=` replaces the array in place)
      errors, raising = Capybara.server_errors.dup, Capybara.raise_server_errors
      example.run
    ensure
      Capybara.server_errors = errors
      Capybara.raise_server_errors = raising
    end

    it 'raises nothing with `raise_server_errors` off, the page\'s 500 the same' do
      Capybara.raise_server_errors = false
      session.visit('/')
      expect(fetch_raising[0]).to eq(500)
      expect { session.visit('/') }.not_to raise_error
      session.visit('/raise')
      expect(session.status_code).to eq(500)
    end

    it 'raises what `server_errors` names alone, the 500 whatever it is' do
      Capybara.server_errors = [KeyError]
      session.visit('/')
      expect(fetch_raising[0]).to eq(500)
      expect { session.visit('/') }.not_to raise_error
    end
  end
end
