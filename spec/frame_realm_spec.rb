require 'capybara/simulated'
require_relative 'support/js_engine'

# Frame-document scripts must execute in the FRAME's realm, whichever
# execution path the runtime routes them through. The leading-lexical and
# ≥64KB bodies go to Ruby host fns (shared-lexical eval / bytecode cache),
# and `type=module` to the native module loader — each of those is
# context-bound, so a main-ctx-bound variant replayed onto the realm would
# run the frame's script against the PARENT document (regression: the
# rusty_racer migration's realm replay did exactly that).
RSpec.describe 'iframe inline-script realm routing' do
  before do
    # Per-frame realms are a V8 (rusty_racer) feature; QuickJS keeps the
    # same-realm fallback by design.
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?
  end

  let(:big_pad) { "// #{'x' * 70_000}\n" }

  let(:app) {
    pad = big_pad
    lambda do |env|
      case env['PATH_INFO']
      when '/frame-lexical'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script>const marker = 'IFRAME-LEXICAL'; document.title = marker;</script></body></html>
        HTML
      when '/frame-plain'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script>document.title = 'IFRAME-PLAIN';</script></body></html>
        HTML
      when '/frame-big'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script>document.title = 'IFRAME-BIG';
          #{pad}</script></body></html>
        HTML
      when '/frame-module'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script type="module">document.title = 'IFRAME-MODULE';</script></body></html>
        HTML
      else
        frame = env['PATH_INFO'].sub('/main', '/frame')
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>MAIN</title></head>
          <body><iframe src="#{frame}"></iframe></body></html>
        HTML
      end
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  def titles_after_visit(path)
    session.visit path
    # Force the frame realm to build + load (contentWindow getter).
    frame_title = session.evaluate_script(
      "document.querySelector('iframe').contentWindow.document.title"
    )
    parent_title = session.evaluate_script('document.title')
    {parent: parent_title, frame: frame_title}
  end

  it 'plain (non-lexical) inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-plain')).to eq(parent: 'MAIN', frame: 'IFRAME-PLAIN')
  end

  it 'leading-lexical inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-lexical')).to eq(parent: 'MAIN', frame: 'IFRAME-LEXICAL')
  end

  it 'big (>=64KB) inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-big')).to eq(parent: 'MAIN', frame: 'IFRAME-BIG')
  end

  it 'module inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-module')).to eq(parent: 'MAIN', frame: 'IFRAME-MODULE')
  end
end

# Same-origin policy on iframe `contentDocument`: a frame is reachable only when
# it is same-origin with the accessing document. A cross-origin frame (different
# host) and a sandboxed frame (opaque origin) expose a WindowProxy via
# `contentWindow` but a null `contentDocument`.
RSpec.describe 'iframe contentDocument same-origin policy' do
  before { skip 'per-frame realms need the V8 engine' unless CsimEngine.v8? }

  let(:app) {
    lambda do |env|
      body = env['PATH_INFO'] == '/child' ? '<!doctype html><html><body>CHILD</body></html>' : '<!doctype html><html><body>ROOT</body></html>'
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  def content_doc_reachable(frame_html)
    session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe');
        #{frame_html}
        document.body.appendChild(f);
        return !!f.contentDocument;
      })()
    JS
  end

  it 'exposes a same-origin frame document' do
    expect(content_doc_reachable("f.src = '/child';")).to be(true)
  end

  it 'hides a cross-origin (different-host) frame document' do
    expect(content_doc_reachable("f.src = 'http://cross.example.org/child';")).to be(false)
  end

  it 'hides a sandboxed frame document (opaque origin)' do
    expect(content_doc_reachable("f.setAttribute('sandbox', ''); f.src = '/child';")).to be(false)
  end
end
