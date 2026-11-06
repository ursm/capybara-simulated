require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What the app raises under a request the page makes reaches the test, as a browser run's: Capybara's server records it
# (Capybara::Server::Middleware) and its session raises it at its next step (`Session#raise_server_error!`), as
# `Capybara.server_errors` and `Capybara.raise_server_errors` say. The page's own view of the request stays a network error. A
# service worker in the way is one more who sees that network error and answers with it: a test went green on a blank page.
RSpec.describe 'an exception of the app under a request of the page' do
  include PollUntil

  let(:pass_through) { "self.addEventListener('install', () => skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));" }
  let(:app) {
    worker = pass_through
    lambda {|env|
      case env['PATH_INFO']
      when '/pass.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/raise', '/raise.js', '/raise.css', '/raise.png', '/raise.woff' then raise ArgumentError, 'of the app'
      when '/stream' then [200, {'content-type' => 'text/event-stream'}, ["data: x\n\n"]]
      when '/frame-raising' then [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe src="/raise"></iframe>']]
      when '/script-raising' then [200, {'content-type' => 'text/html'}, ['<!doctype html><script src="/raise.js"></script><p>x</p>']]
      when '/sheet-raising' then [200, {'content-type' => 'text/html'}, ['<!doctype html><link rel="stylesheet" href="/raise.css"><p>x</p>']]
      when '/image-raising' then [200, {'content-type' => 'text/html'}, ['<!doctype html><img src="/raise.png"><p>x</p>']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><p>x</p>']]
      end
    }
  }
  let(:session) { simulated_session(app) }
  after {
    begin
      session.reset_session!
    rescue ArgumentError
      nil
    end
  }

  def fetch_raising = session.evaluate_async_script("const d = arguments[0]; fetch('/raise').then((r) => d(r.status), (e) => d(e.name))")
  def controlled
    session.visit('/')
    session.evaluate_async_script("const d = arguments[0]; navigator.serviceWorker.register('/pass.js').then(() => navigator.serviceWorker.ready).then(d)")
    expect(poll_until { session.evaluate_script('!!navigator.serviceWorker.controller') }).to be(true)
  end

  it 'gives the page a network error, and the driver raises it at its next call' do
    session.visit('/')
    expect(fetch_raising).to eq('TypeError')
    expect { session.evaluate_script('1') }.to raise_error(ArgumentError, 'of the app')
    # (…once)
    expect(session.evaluate_script('1')).to eq(1)
  end

  it 'raises a synchronous XHR\'s at the next visit' do
    session.visit('/')
    session.execute_script("const x = new XMLHttpRequest(); x.open('GET', '/raise', false); try { x.send(); } catch (e) { window.threw = e.name; }")
    expect { session.visit('/') }.to raise_error(ArgumentError)
  end

  it 'raises it at the end of the test, with nothing else asked: the session\'s reset, done all the same' do
    session.visit('/')
    expect(fetch_raising).to eq('TypeError')
    expect { session.reset_session! }.to raise_error(ArgumentError)
    expect(session.current_url).to eq('about:blank').or eq('')
  end

  it 'raises it at a node\'s next read' do
    session.visit('/')
    node = session.find('p')
    expect(fetch_raising).to eq('TypeError')
    expect { node.text }.to raise_error(ArgumentError)
  end

  it 'raises a navigation\'s a service worker passed through' do
    controlled
    expect { session.visit('/raise') }.not_to raise_error
    expect { session.visit('/') }.to raise_error(ArgumentError, 'of the app')
  end

  it 'raises a subresource fetch\'s a service worker passed through' do
    controlled
    expect(fetch_raising).to eq('TypeError')
    expect { session.visit('/') }.to raise_error(ArgumentError)
  end

  %w[script sheet image].each do |kind|
    it "raises a #{kind}'s, with no service worker" do
      session.visit("/#{kind}-raising")
      expect { session.evaluate_script('document.title') }.to raise_error(ArgumentError)
    end
  end

  it 'raises a frame\'s, with no service worker' do
    session.visit('/frame-raising')
    expect { session.evaluate_script('document.title') }.to raise_error(ArgumentError, 'of the app')
  end

  it 'is the app\'s alone: a redirect the request refuses raises nothing' do
    session.visit('/')
    expect(session.evaluate_async_script("const d = arguments[0]; fetch('http://[bad').then(() => d('ok'), (e) => d(e.name))")).to eq('TypeError')
    expect { session.visit('/') }.not_to raise_error
  end

  # (…another host's request the network refused comes to the app, for a 404: Forem's page, a script off a CDN)
  it 'raises nothing of another host\'s request the app was only asked as the network refused it' do
    allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch).and_return(nil)
    session.visit('/')
    session.evaluate_async_script("const d = arguments[0]; fetch('http://cdn.test/raise', {mode: 'no-cors'}).then(() => d('ok'), (e) => d(e.name))")
    expect { session.visit('/') }.not_to raise_error
  end

  describe 'Capybara\'s settings' do
    around do |example|
      errors, raising = Capybara.server_errors, Capybara.raise_server_errors
      example.run
    ensure
      Capybara.server_errors = errors
      Capybara.raise_server_errors = raising
    end

    it 'raises nothing with `raise_server_errors` off' do
      Capybara.raise_server_errors = false
      session.visit('/')
      expect(fetch_raising).to eq('TypeError')
      expect { session.visit('/') }.not_to raise_error
    end

    it 'raises what `server_errors` names alone' do
      Capybara.server_errors = [KeyError]
      session.visit('/')
      expect(fetch_raising).to eq('TypeError')
      expect { session.visit('/') }.not_to raise_error
    end
  end
end
