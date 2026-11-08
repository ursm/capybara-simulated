# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What the host hands a realm and what it takes back go through nothing a page can replace: a host step reads the
# engine's answers and the host's arguments by index, not by the iterator `Array.prototype` has (engine.js `listOf`);
# the steps the host calls by name are no page's to call (`hostSteps`, behind the host's token) and the functions the
# bindings reach by a global's name read-only from the realm's first script on (`sealHostHooks`); and a window's parent
# and top are the host's to set, kept where no script can name them (`realmHooks`).
RSpec.describe 'the host boundary' do
  let(:pages) {
    {
      '/'       => '<!DOCTYPE html><meta charset=utf-8><body><input id=i><form id=f action=/sent><button id=b>go</button></form>',
      '/sent'   => '<!DOCTYPE html><title>sent</title>',
      '/c'      => '<!DOCTYPE html><script>window.ao = [...location.ancestorOrigins].join(","); window.topIsParent = top === parent</script>',
      '/frames' => <<~HTML,
        <!DOCTYPE html><body><iframe id=f src="/tick"></iframe><iframe id=x src="http://evil.test/ad"></iframe>
        <script>window.ticks = 0; setInterval(() => ticks++, 10);</script>
      HTML
      '/arrays' => '<!DOCTYPE html><body><p class=a>one</p><p class=a>two</p><select id=s multiple><option selected>x</option><option selected>y</option></select>',
      '/tick'   =>'<!DOCTYPE html><script>window.ticks = 0; setInterval(() => ticks++, 10);</script>',
      '/ad'     => <<~HTML,
        <!DOCTYPE html><script>
          window.kill = () => {
            for (let i = 0; i < 6; i++) {
              try { __csimDiscardRealms([i]); } catch (_) {}
              try { RustyRacer.discardRealms([i]); } catch (_) {}
            }
            try { __csimActivationNotify(); } catch (_) {}
            try { RustyRacer.activationNotify(); } catch (_) {}
            window.active = navigator.userActivation.isActive;
          };
        </script>
      HTML
      '/muted'  => <<~HTML
        <!DOCTYPE html><meta charset=utf-8><body>
        <script>
          window.msgs = [];
          addEventListener('error', (e) => { msgs.push([e.message, e.filename, e.lineno, e.error === null]); });
          const orig = Array.prototype[Symbol.iterator];
          Array.prototype[Symbol.iterator] = function () { if (this.length === 5 && this[0] === true) this[0] = false; return orig.call(this); };
        </script>
        <script src="http://other.test/s.js"></script>
      HTML
    }
  }
  let(:app) {
    pages = self.pages
    lambda do |env|
      next [200, {'content-type' => 'text/javascript'}, ["var x = 1;\nthrow new Error('cross-origin secret');"]] if env['PATH_INFO'] == '/s.js'

      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '<!DOCTYPE html>')]]
    end
  }
  let(:session) { simulated_session(app) }

  # (…HTML "report an exception": a classic script of another origin, without CORS, reports "Script error." and no
  # site — whatever the page did to the iterator the report's site would have been read by)
  it "keeps a cross-origin script's error muted whatever the page's array iterator" do
    session.visit '/muted'
    expect(session.evaluate_script('msgs')).to eq([['Script error.', '', 0, true]])
  end

  # A page's iterator sees none of what the host's steps carry: a value set, keys sent, a click.
  it "hands a page's array iterator nothing of the host's steps" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.seen = 0;
      const orig = Array.prototype[Symbol.iterator];
      window.restore = () => { Array.prototype[Symbol.iterator] = orig; };
      Array.prototype[Symbol.iterator] = function () { window.seen++; return orig.call(this); };
    JS
    session.find(:css, '#i').set('typed')
    session.find(:css, '#i').send_keys('k', [:shift, 'a'])
    session.find(:css, '#i').click
    expect(session.evaluate_script('[window.seen, document.getElementById("i").value]')).to eq([0, 'typedkA'])
  end

  # What the driver finds is the document's, whatever a page — an app, a library that patches arrays — made of
  # `Array.prototype`: the host's steps build and read their lists by index (engine.js `listMap`, `listBuild`), as a
  # real browser's driver answers from outside the page's script.
  it "finds what the document holds whatever a page made of Array.prototype's methods" do
    session.visit '/arrays'
    session.execute_script(<<~JS)
      const keep = (name, wrong) => { const orig = Array.prototype[name]; Array.prototype[name] = function (...a) { return wrong(orig.apply(this, a), this); }; };
      keep('map', (r) => r.slice(0, 1));
      keep('push', (r, list) => { list.length = 0; return 0; });
      keep('includes', () => true);
    JS
    expect(session.all(:css, 'p.a').map(&:text)).to eq(%w[one two])
    expect(session.all(:xpath, '//p').map(&:text)).to eq(%w[one two])
    expect(session.find(:css, '#s').value).to eq(%w[x y])
  end

  # …nor of the event loop's: the rendering update's resize steps over the frames, a frame's task run in its realm
  # (a page's fake global among the realms would have its "task" run), and the custom element reactions an operation
  # of the page's leaves — whose elements the page's iterator would be handed.
  it "hands a page's array iterator nothing of the event loop's steps" do
    session.visit '/frames'
    expect(poll_until { session.evaluate_script("document.getElementById('f').contentWindow.ticks > 2") }).to be(true)
    session.execute_script(<<~JS)
      window.seen = 0;
      window.reacted = [];
      customElements.define('x-e', class extends HTMLElement { connectedCallback() { reacted.push(this.localName); } });
      const orig = Array.prototype[Symbol.iterator];
      Array.prototype[Symbol.iterator] = function () { window.seen++; return orig.call(this); };
    JS
    ticks = session.evaluate_script("document.getElementById('f').contentWindow.ticks")
    session.current_window.resize_to(500, 400)
    expect(poll_until { session.evaluate_script("document.getElementById('f').contentWindow.ticks") > ticks + 2 }).to be(true)
    session.execute_script("document.body.append(document.createElement('x-e'))")
    expect(session.evaluate_script('[window.seen, reacted.length]')).to eq([0, 1])
  end

  # The steps the host calls a realm by — and whose answers it acts on — are no property of any global, and the
  # namespace's way to them names them to no script: only the host's token, which no page has, opens it. A page neither
  # calls nor replaces one.
  it 'lets no page call a step the host calls' do
    session.visit '/'
    names = %w[__csimTakeRoutedSubmission __csimSubmissionRoute __csimFlushRestore __csimApplyWindowTraversals
               __csimDiscardRealms __runLoopStep __csimSetValue __csimActivationNotify __csimDispatchTrusted]
    expect(session.evaluate_script(<<~JS)).to eq([names.map { 'undefined' }, [], [false, false], 'undefined'])
      [
        #{names.to_json}.map((name) => typeof globalThis[name]),
        Reflect.ownKeys(RustyRacer),
        [Reflect.defineProperty(RustyRacer, 'x', { value: 1 }), 'discardRealms' in RustyRacer],
        typeof RustyRacer.engine
      ]
    JS
  end

  # (…a cross-origin frame's script among them: it stops no timer of its parent's or a sibling's by discarding their
  # realms, nor grants itself the transient activation only a user's gesture gives (HTML "activation notification"))
  it "lets a frame's script neither discard another realm nor grant itself activation" do
    session.visit '/frames'
    expect(poll_until { session.evaluate_script("window.ticks > 2 && document.getElementById('f').contentWindow.ticks > 2") }).to be(true)
    session.within_frame('x') { session.execute_script('kill()') }
    before = session.evaluate_script("[window.ticks, document.getElementById('f').contentWindow.ticks]")
    expect(poll_until { session.evaluate_script("[window.ticks, document.getElementById('f').contentWindow.ticks]").zip(before).all? { _1 > _2 } }).to be(true)
    expect(session.within_frame('x') { session.evaluate_script('window.active') }).to be(false)
  end

  # (…but none of the host's own procs is sealed in the snapshot, where the bindings have a stub of one: the host's
  # attach over a read-only global would fail without a word — the bindings' list is the host's)
  it "names the host's own procs as the host attaches them" do
    lib = File.expand_path('../lib/capybara/simulated', __dir__)
    shared = File.read(File.join(lib, 'runtime_shared.rb'))[/BROWSER_HOST_FNS = \{(.*?)^ {6}\}/m, 1]
    attached = shared.scan(/^\s+['"]?(__[A-Za-z0-9_]+)['"]?\s*(?:=>|:)/).flatten +
               Dir[File.join(lib, '*.rb')].flat_map { File.read(_1).scan(/attach\(['"](__[A-Za-z0-9_]+)/).flatten }
    engine = File.read(File.join(lib, 'js/src/engine.js'))
    procs = engine[/HOST_PROCS = new Set\(\[(.*?)\]\)/m, 1].scan(/'([^']+)'/).flatten
    expect(procs.sort).to eq(attached.uniq.select { _1.start_with?('__csim') && !_1.start_with?('__csim_') }.sort)
  end

  # (…[LegacyUnforgeable] `parent` and `top`, and `ancestorOrigins`: the host's to set as it makes a frame — a page's
  # globals of the driver's old names change neither the frame's nor its own)
  it "takes no window a page names for a frame's parent or top" do
    session.visit '/'
    session.execute_script("window.pop = window.open('http://trusted.test/c'); window.__csimParent = window.__csimTop = window.pop;")
    session.execute_script("const f = document.createElement('iframe'); f.id = 'c'; f.src = '/c'; document.body.appendChild(f);")
    expect(poll_until { session.evaluate_script("document.getElementById('c').contentWindow.ao") }).to eq('http://www.example.com')
    expect(session.evaluate_script("document.getElementById('c').contentWindow.topIsParent")).to be(true)
    expect(session.evaluate_script('[top === window, parent === window]')).to eq([true, true])
  end
end
