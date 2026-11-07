# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What the host hands a realm and what it takes back go through nothing a page can replace: a host step reads the
# engine's answers and the host's arguments by index, not by the iterator `Array.prototype` has (engine.js `listOf`);
# the functions the host calls by name are read-only from the realm's first script on (`sealHostHooks`); and a window's
# parent and top are the host's to set, kept where no script can name them (`realmHooks`).
RSpec.describe 'the host boundary' do
  let(:pages) {
    {
      '/'       => '<!DOCTYPE html><meta charset=utf-8><body><input id=i><form id=f action=/sent><button id=b>go</button></form>',
      '/sent'   => '<!DOCTYPE html><title>sent</title>',
      '/c'      => '<!DOCTYPE html><script>window.ao = [...location.ancestorOrigins].join(","); window.topIsParent = top === parent</script>',
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

  # The functions the host calls by name, and whose answers it acts on, are no page's to replace.
  it 'lets no page replace a function the host calls' do
    session.visit '/'
    names = %w[__csimTakeRoutedSubmission __csimSubmissionRoute __csimFlushRestore __csimApplyWindowTraversals
               __csimDiscardRealms __runLoopStep __csim_runScript __csimSetValue __csimReportException]
    expect(session.evaluate_script(<<~JS)).to eq(names.map { [false, false, true] })
      #{names.to_json}.map((name) => {
        const before = globalThis[name];
        try { globalThis[name] = () => 'page'; } catch (_) {}
        const d = Object.getOwnPropertyDescriptor(globalThis, name);
        return [d.writable, d.configurable, globalThis[name] === before];
      })
    JS
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
    called = engine[/HOST_CALLED = new Set\(\[(.*?)\]\)/m, 1].scan(/'([^']+)'/).flatten
    expect(procs.sort).to eq(attached.uniq.select { _1.start_with?('__csim') && !_1.start_with?('__csim_') }.sort)
    expect(called & attached).to eq([])
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
