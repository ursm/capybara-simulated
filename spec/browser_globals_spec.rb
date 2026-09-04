require 'capybara/simulated'
require_relative 'support/session_teardown'

# Globals real apps probe at boot or use during a test. Specs here lock
# the bridge's contract for each one — apps that hit `if (typeof X)`
# guards or actually call these methods shouldn't silently misbehave.
RSpec.describe 'browser global surface' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']]
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  describe 'URL / location' do
    it 'omits default ports from host, port, href, and origin' do
      result = session.evaluate_script(<<~JS)
        const http = new URL('http://example.test:80/path');
        const https = new URL('https://example.test:443/path');
        ({
          httpHost: http.host,
          httpPort: http.port,
          httpHref: http.href,
          httpOrigin: http.origin,
          httpsHost: https.host,
          httpsPort: https.port,
          httpsHref: https.href,
          httpsOrigin: https.origin
        })
      JS

      expect(result).to eq(
        'httpHost' => 'example.test',
        'httpPort' => '',
        'httpHref' => 'http://example.test/path',
        'httpOrigin' => 'http://example.test',
        'httpsHost' => 'example.test',
        'httpsPort' => '',
        'httpsHref' => 'https://example.test/path',
        'httpsOrigin' => 'https://example.test'
      )
    end
  end

  describe 'localStorage / sessionStorage' do
    it 'round-trips set + get within a session' do
      session.evaluate_script("localStorage.setItem('k', 'v')")
      expect(session.evaluate_script("localStorage.getItem('k')")).to eq('v')
    end

    it 'reports length and key(i)' do
      session.evaluate_script("localStorage.setItem('a', '1'); localStorage.setItem('b', '2')")
      expect(session.evaluate_script('localStorage.length')).to eq(2)
      keys = (0...2).map {|i| session.evaluate_script("localStorage.key(#{i})") }
      expect(keys).to contain_exactly('a', 'b')
    end

    it 'returns null for missing keys' do
      expect(session.evaluate_script("localStorage.getItem('missing')")).to be_nil
    end

    it 'sessionStorage is independent of localStorage' do
      session.evaluate_script("localStorage.setItem('x', 'l'); sessionStorage.setItem('x', 's')")
      expect(session.evaluate_script("localStorage.getItem('x')")).to eq('l')
      expect(session.evaluate_script("sessionStorage.getItem('x')")).to eq('s')
    end
  end

  describe 'performance' do
    it 'exposes performance.now() as a monotonic millisecond reading' do
      first  = session.evaluate_script('performance.now()')
      second = session.evaluate_script('performance.now()')
      expect(first).to be_a(Numeric)
      expect(second).to be >= first
    end

    it 'records mark / measure entries observable via getEntries* / clearMarks / clearMeasures' do
      expect(session.evaluate_script('typeof performance.timeOrigin')).to eq('number')
      result = session.evaluate_script(<<~JS)
        performance.clearMarks(); performance.clearMeasures();
        performance.mark('start');
        performance.mark('end');
        performance.measure('span', 'start', 'end');
        // getEntries() is sorted by startTime — a measure carries its start mark's time, so its
        // place among later marks depends on the clock; assert per type (insertion order within a
        // type is deterministic) plus the whole set.
        ({
          marks:    performance.getEntriesByType('mark').map(e => e.name),
          measures: performance.getEntriesByType('measure').map(e => e.name),
          all:      performance.getEntries().map(e => e.name + ':' + e.entryType).sort()
        })
      JS
      expect(result['marks']).to eq(%w[start end])
      expect(result['measures']).to eq(['span'])
      expect(result['all']).to eq(['end:mark', 'span:measure', 'start:mark'])
      cleared = session.evaluate_script('performance.clearMarks(); performance.clearMeasures(); performance.getEntries().length')
      expect(cleared).to eq(0)
    end
  end

  describe 'structuredClone' do
    it 'deep-clones plain objects and arrays' do
      cloned = session.evaluate_script(<<~JS)
        const orig = {a: 1, b: {c: 2}, d: [3, 4]};
        const copy = structuredClone(orig);
        copy.b.c = 99;
        copy.d.push(5);
        ({orig: orig, copy: copy})
      JS
      expect(cloned['orig']).to eq('a' => 1, 'b' => {'c' => 2}, 'd' => [3, 4])
      expect(cloned['copy']).to eq('a' => 1, 'b' => {'c' => 99}, 'd' => [3, 4, 5])
    end

    it 'returns primitives unchanged' do
      expect(session.evaluate_script("structuredClone(42)")).to eq(42)
      expect(session.evaluate_script("structuredClone('hi')")).to eq('hi')
      expect(session.evaluate_script("structuredClone(null)")).to be_nil
    end
  end

  describe 'requestIdleCallback / cancelIdleCallback' do
    it 'fires the callback after the timer queue drains' do
      session.evaluate_script(<<~JS)
        window.__idle = false;
        requestIdleCallback(() => { window.__idle = true });
        __drainTimers(1);
      JS
      expect(session.evaluate_script('window.__idle')).to eq(true)
    end

    it 'cancelIdleCallback cancels a pending callback' do
      session.evaluate_script(<<~JS)
        window.__idle = false;
        const id = requestIdleCallback(() => { window.__idle = true });
        cancelIdleCallback(id);
        __drainTimers(1);
      JS
      expect(session.evaluate_script('window.__idle')).to eq(false)
    end
  end

  describe 'document.implementation.createHTMLDocument' do
    # jQuery feature-detects with
    # `(createHTMLDocument("").body).innerHTML = "<form></form><form></form>"`
    # and counts childNodes. Returning the live document would clobber
    # the page body — every call must give a fresh detached body.
    it 'returns a fresh body that is independent of document.body' do
      result = session.evaluate_script(<<~JS)
        const doc = document.implementation.createHTMLDocument("");
        doc.body.innerHTML = "<form></form><form></form>";
        ({
          fresh_body_count: doc.body.childNodes.length,
          page_body_count:  document.body.childNodes.length,
          shares_body:      doc.body === document.body
        })
      JS
      expect(result).to eq(
        'fresh_body_count' => 2,
        'page_body_count'  => 0,
        'shares_body'      => false
      )
    end

    it 'exposes head / documentElement on the new document' do
      shape = session.evaluate_script(<<~JS)
        const doc = document.implementation.createHTMLDocument("");
        ({
          has_head:    doc.head?.tagName === 'HEAD',
          has_html:    doc.documentElement?.tagName === 'HTML',
          body_in_html: doc.documentElement?.contains(doc.body)
        })
      JS
      expect(shape).to eq(
        'has_head'     => true,
        'has_html'     => true,
        'body_in_html' => true
      )
    end
  end

  describe 'Text#splitText' do
    it 'splits a text node at offset, keeps prefix in-place and inserts the suffix node after it' do
      shape = session.evaluate_script(<<~JS)
        const host = document.createElement('div');
        const t = document.createTextNode('hello world');
        host.appendChild(t);
        const suffix = t.splitText(5);
        ({
          prefix:        t.data,
          suffix:        suffix.data,
          siblings:      Array.from(host.childNodes).map(n => n.data),
          suffixIsText:  suffix.nodeName === '#text',
          suffixParent:  suffix.parentNode === host
        })
      JS
      expect(shape).to eq(
        'prefix'       => 'hello',
        'suffix'       => ' world',
        'siblings'     => ['hello', ' world'],
        'suffixIsText' => true,
        'suffixParent' => true
      )
    end

    it 'throws IndexSizeError for out-of-range offsets' do
      err = session.evaluate_script(<<~JS)
        (() => {
          const t = document.createTextNode('hi');
          try { t.splitText(10); return 'no-throw'; }
          catch (e) { return e.name; }
        })()
      JS
      expect(err).to eq('IndexSizeError')
    end
  end

  describe 'document.fonts (CSS Font Loading)' do
    # FontFaceSet is an EventTarget per spec. Listening on it is unconditional in the
    # wild — react-textarea-autosize (Mastodon's compose form) does
    # `if (el) el.addEventListener('loadingdone', …)` on `document.fonts`, so a set that
    # is truthy but not an EventTarget passes the guard and then throws, taking the
    # whole React tree down with it.
    it 'is an EventTarget and accepts the loading-family listeners' do
      shape = session.evaluate_script(<<~JS)
        const fonts = document.fonts;
        ({
          isEventTarget: fonts instanceof EventTarget,
          addFn:         typeof fonts.addEventListener,
          removeFn:      typeof fonts.removeEventListener,
          dispatchFn:    typeof fonts.dispatchEvent,
          handlers:      ['onloading', 'onloadingdone', 'onloadingerror'].every(h => h in fonts)
        })
      JS

      expect(shape).to eq(
        'isEventTarget' => true,
        'addFn'         => 'function',
        'removeFn'      => 'function',
        'dispatchFn'    => 'function',
        'handlers'      => true
      )
    end

    it 'round-trips a dispatched loadingdone through both listener and on-handler' do
      seen = session.evaluate_script(<<~JS)
        (() => {
          const out = [];
          document.fonts.addEventListener('loadingdone', () => out.push('listener'));
          document.fonts.onloadingdone = () => out.push('handler');
          document.fonts.dispatchEvent(new Event('loadingdone'));
          return out;
        })()
      JS

      expect(seen).to eq(['listener', 'handler'])
    end

    it 'keeps the handlers off the instance, as own properties of the prototype' do
      # They used to be own `null` fields on the set, so `Object.keys(document.fonts)`
      # listed them; in a browser the set has no own keys at all.
      shape = session.evaluate_script(<<~JS)
        ({
          ownKeys:    Object.keys(document.fonts),
          enumerable: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document.fonts), 'onloadingdone').enumerable
        })
      JS

      expect(shape).to eq('ownKeys' => [], 'enumerable' => true)
    end
  end

  describe 'screen.orientation' do
    # ScreenOrientation is an EventTarget per spec — same trap as document.fonts: a
    # truthy plain object passes an `if (screen.orientation)` guard, then throws on
    # addEventListener. A fixed viewport never rotates, so `change` never fires.
    it 'is an EventTarget carrying the spec surface' do
      shape = session.evaluate_script(<<~JS)
        const o = screen.orientation;
        ({
          isEventTarget: o instanceof EventTarget,
          addFn:         typeof o.addEventListener,
          type:          o.type,
          angle:         o.angle,
          tag:           Object.prototype.toString.call(o),
          onchange:      'onchange' in o,
          unlockFn:      typeof o.unlock,
          globalCtor:    typeof ScreenOrientation
        })
      JS

      expect(shape).to eq(
        'isEventTarget' => true,
        'addFn'         => 'function',
        'type'          => 'landscape-primary',
        'angle'         => 0,
        'tag'           => '[object ScreenOrientation]',
        'onchange'      => true,
        'unlockFn'      => 'function',
        'globalCtor'    => 'function'
      )
    end

    it 'rejects lock() with NotSupportedError, as headless Chrome does on a desktop profile' do
      session.execute_script(<<~JS)
        window.__lock = 'pending';
        screen.orientation.lock('portrait').then(
          () => { window.__lock = 'resolved'; },
          (e) => { window.__lock = e.name; }
        );
      JS

      expect(session.evaluate_script('window.__lock')).to eq('NotSupportedError')
    end
  end

  describe 'observer stubs' do
    it 'IntersectionObserver / ResizeObserver / PerformanceObserver construct cleanly and have spec methods' do
      # `unobserve` is on Intersection / Resize / Mutation observers
      # but NOT on PerformanceObserver per spec.
      shape = session.evaluate_script(<<~JS)
        const probe = (Cls, methods) => {
          const o = new Cls(() => {});
          return methods.every(m => typeof o[m] === 'function');
        };
        ({
          io: probe(IntersectionObserver, ['observe', 'unobserve', 'disconnect', 'takeRecords']),
          ro: probe(ResizeObserver,       ['observe', 'unobserve', 'disconnect', 'takeRecords']),
          po: probe(PerformanceObserver,  ['observe', 'disconnect', 'takeRecords'])
        })
      JS
      expect(shape).to eq('io' => true, 'ro' => true, 'po' => true)
    end
  end
end
