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
      when '/reads.js' then [200, {'content-type' => 'text/javascript'}, ["postMessage([self.caches, navigator.serviceWorker, navigator.locks, crypto.subtle, crypto.randomUUID, self.Cache, self.Lock].map((v) => typeof v))"]]
      when '/shared.js' then [200, {'content-type' => 'text/javascript'}, ['onconnect = (e) => e.ports[0].postMessage(isSecureContext)']]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<p>frame</p>']]
      when '/framed-a' then [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe name="fr" src="http://a.test/frame"></iframe>']]
      when '/framed-local' then [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe name="fr" src="http://localhost/frame"></iframe>']]
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

  # (…a pop-up's initial about:blank its creator's top-level creation URL, HTML "create a new browsing context and document";
  # Chrome and Firefox alike. Its first document's own after)
  it 'takes a pop-up\'s initial about:blank as its creator\'s, its first document as its own', :every_host_local do
    session.visit('http://a.test/')
    session.execute_script("window.w = open('')")
    expect(session.evaluate_script('[w.location.href, w.isSecureContext]')).to eq(['about:blank', false])
    session.execute_script("window.f = w.document.body.appendChild(w.document.createElement('iframe'))")
    expect(session.evaluate_script('f.contentWindow.isSecureContext')).to be(false)
    session.visit('https://a.test/')
    session.execute_script("window.w = open('')")
    expect(session.evaluate_script('w.isSecureContext')).to be(true)
    session.execute_script("window.h = open('http://a.test/frame')")
    session.within_window(session.windows.last) do
      expect(session).to have_css('p')
      expect(session.evaluate_script('isSecureContext')).to be(false)
    end
  end

  # (…a session's own, whatever another of the process was made as since: a new session of every host, or the reverse)
  it 'keeps the stand-in a session was made with, another session made since' do
    session.visit('/')
    other = EveryHostLocal.within { simulated_session(app).tap {|s| s.visit('http://www.example.com/') } }
    expect(other.evaluate_script('isSecureContext')).to be(false)
    session.visit('/frame')
    expect(session.evaluate_script('isSecureContext')).to be(true)
    session.visit('/')
    expect(session.evaluate_script('crossOriginIsolated')).to be(true)
  end

  # Web IDL "exposed": a [SecureContext] construct is absent where the environment is no secure context, not a getter
  # answering undefined — as a member and as an interface object, on the global and on a prototype. Chrome and Firefox on a
  # LAN IP alike: `serviceWorker`, `clipboard`, `credentials`, `locks`, `mediaDevices`, `subtle`, `randomUUID`, `caches`.
  describe '[SecureContext] constructs' do
    let(:members) {
      [
        "'serviceWorker' in navigator",
        "'clipboard' in navigator",
        "'credentials' in navigator",
        "'locks' in navigator",
        "'mediaDevices' in navigator",
        "'registerProtocolHandler' in navigator",
        "'subtle' in crypto",
        "'randomUUID' in crypto",
        "'caches' in self",
        "'ServiceWorker' in self",
        "'ServiceWorkerContainer' in self",
        "'Cache' in self",
        "'CacheStorage' in self",
        "'SubtleCrypto' in self",
        "'CryptoKey' in self",
        "'Clipboard' in self",
        "'LockManager' in self",
        "'PublicKeyCredential' in self",
        "'DeviceMotionEvent' in self",
        "'onpointerrawupdate' in HTMLElement.prototype",
        "'getCoalescedEvents' in PointerEvent.prototype"
      ]
    }
    let(:reads) { "[#{members.join(', ')}]" }

    it 'has none of them where it is none, its frame neither', :every_host_local do
      session.visit('http://a.test/')
      expect(session.evaluate_script(reads).uniq).to eq([false])
      expect(session.evaluate_script("[Object.getOwnPropertyDescriptor(Navigator.prototype, 'locks'), Object.getOwnPropertyDescriptor(self, 'caches'), navigator.serviceWorker, crypto.subtle]")).to all(be_nil)
      # (…all else as it was: what is exposed everywhere of the same interfaces)
      expect(session.evaluate_script("[typeof crypto.getRandomValues, typeof navigator.userAgent, typeof fetch, typeof Crypto, typeof Navigator]")).to eq(%w[function string function function function])
      session.within_frame('fr') { expect(session.evaluate_script(reads).uniq).to eq([false]) }
    end

    it 'has every one where it is one', :every_host_local do
      session.visit('https://a.test/')
      expect(session.evaluate_script(reads).uniq).to eq([true])
    end

    it 'has every one on the default host, which stands for the loopback' do
      session.visit('/')
      expect(session.evaluate_script(reads).uniq).to eq([true])
    end

    it 'has none of them in a worker of a page where it is none, and every one in a worker where it is one', :every_host_local do
      read = "const w = new Worker('/reads.js'); w.onmessage = (e) => arguments[0](e.data)"
      session.visit('http://a.test/')
      expect(session.evaluate_async_script(read).uniq).to eq(['undefined'])
      session.visit('https://a.test/')
      expect(session.evaluate_async_script(read)).to eq(%w[object object object object function function function])
    end

    it 'has them in a realm a page made none of, the Window the next page makes a new one', :every_host_local do
      session.visit('http://a.test/')
      session.visit('https://a.test/')
      expect(session.evaluate_script(reads).uniq).to eq([true])
      session.visit('http://a.test/')
      expect(session.evaluate_script(reads).uniq).to eq([false])
    end

    # (…a kept Window: its first document's environment of its own top-level creation URL, no longer its creator's; so the
    # same realm has them after where it had none before, and the other way. Measured of Chrome 157 and Firefox 159, for a
    # frame on `localhost` under a LAN IP's page: their initial about:blank reads as its document will, so what a realm is
    # decided as never changes there. This engine's `isSecureContext` of it is the text's; what is exposed goes with that.)
    it 'follows the document a kept Window goes on to, none before and one after', :every_host_local do
      session.visit('http://a.test/framed-local')
      session.within_frame('fr') do
        session.execute_script("window.w = open('http://localhost/frame'); w.marker = 1; window.blank = [w.isSecureContext, w.location.href]; window.before = #{reads.gsub('navigator', 'w.navigator').gsub('crypto', 'w.crypto').gsub(' in self', ' in w')};")
        expect(session.evaluate_script('blank')).to eq([false, 'about:blank'])
        expect(session.evaluate_script('before').uniq).to eq([false])
      end
      session.within_window(session.windows.last) do
        expect(session).to have_css('p')
        expect(session.evaluate_script('[marker, isSecureContext]')).to eq([1, true])
        expect(session.evaluate_script(reads).uniq).to eq([true])
        expect(session.evaluate_script('typeof navigator.serviceWorker.register')).to eq('function')
      end
    end

    it 'follows the document a kept Window goes on to, one before and none after', :every_host_local do
      session.visit('http://localhost/framed-a')
      session.within_frame('fr') do
        session.execute_script("window.w = open('http://a.test/frame'); w.marker = 1; window.blank = [w.isSecureContext, w.location.href]; window.before = #{reads.gsub('navigator', 'w.navigator').gsub('crypto', 'w.crypto').gsub(' in self', ' in w')};")
        expect(session.evaluate_script('blank')).to eq([true, 'about:blank'])
        expect(session.evaluate_script('before').uniq).to eq([true])
      end
      session.within_window(session.windows.last) do
        expect(session).to have_css('p')
        expect(session.evaluate_script('[marker, isSecureContext]')).to eq([1, false])
        expect(session.evaluate_script(reads).uniq).to eq([false])
      end
    end

    # (…the holder as the bundle made it, whatever a page's name for it says since)
    it 'takes them from what the bundle made, a page having renamed it', :every_host_local do
      session.visit('http://localhost/framed-a')
      session.within_frame('fr') { session.execute_script("window.w = open('http://a.test/frame'); w.Navigator = function () {}; w.Navigator.prototype = {};") }
      session.within_window(session.windows.last) do
        expect(session).to have_css('p')
        expect(session.evaluate_script("'serviceWorker' in navigator")).to be(false)
      end
    end
  end

  # (…none where it is none, Geolocation's permission denied: Chrome and Firefox on a LAN IP alike)
  it 'denies geolocation where it is none, a watch removed with it', :every_host_local do
    session.visit('http://a.test/')
    expect(session.evaluate_async_script("navigator.geolocation.getCurrentPosition(() => arguments[0]('position'), (e) => arguments[0](e.code))")).to eq(1)
    expect(session.evaluate_async_script("navigator.geolocation.watchPosition(() => arguments[0]('position'), (e) => arguments[0](e.code))")).to eq(1)
  end

  # (…a secure context's to register, as a real 127.0.0.1's: no "universal server" asked for)
  it 'registers a service worker on the default host' do
    session.visit('/')
    expect(session.evaluate_async_script("navigator.serviceWorker.register('/shared.js', {scope: '/'}).then((r) => arguments[0](r.scope), (e) => arguments[0](e.name))")).to eq('http://www.example.com/')
  end

  # HTML "SharedWorker constructor": "If workerIsSecureContext is not callerIsSecureContext", `error` at the worker, no
  # connection. A pop-up's initial about:blank of a frame on a.test under a secure top is one of a.test's site and a secure
  # context; a page of a.test is none.
  it 'fails a shared worker of a secure context where its caller is none', :every_host_local do
    connect = lambda {|constructor|
      "const done = arguments[0]; const s = new #{constructor}('http://a.test/shared.js', 'n'); s.onerror = () => done('error'); s.port.onmessage = (e) => done(e.data)"
    }
    session.visit('http://localhost/framed-a')
    session.within_frame('fr') do
      session.execute_script("window.w = open('')")
      expect(session.evaluate_async_script(connect.call('w.SharedWorker'))).to be(true)
      session.execute_script("open('http://a.test/frame')")
    end
    session.within_window(session.windows.last) do
      expect(session).to have_css('p')
      expect(session.evaluate_script('isSecureContext')).to be(false)
      expect(session.evaluate_async_script(connect.call('SharedWorker'))).to eq('error')
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
