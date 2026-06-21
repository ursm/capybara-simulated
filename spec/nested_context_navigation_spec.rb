require 'capybara/simulated'
require 'rack'
require_relative 'support/js_engine'

# Navigation initiated INSIDE a nested browsing context — a frame realm reached
# via `iframe.contentWindow.document` rather than an entered `within_frame`
# block. The WPT shadow-dom suite drives these two shapes (html-forms/test-003,
# inert-html-elements/test-001): a <form target=NAME> GET-submit to a sibling
# iframe within the nested document, and a self-targeted link click that
# reloads the nested document (discarding its descendant frames). The per-realm
# pending-navigation/-submit slots live on the nested document's globalThis, so
# they're routed to Ruby through realm-tagged host calls and drained there.
RSpec.describe 'nested-context navigation' do
  before do
    # Nested browsing contexts are modeled as per-frame realms, a V8
    # (rusty_racer) feature; QuickJS keeps the same-realm iframe fallback.
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?
  end

  def session
    app = lambda do |env|
      path = env['PATH_INFO'].to_s
      body =
        if path.end_with?('blank.html')
          '<!DOCTYPE html><html><head></head><body></body></html>'
        elsif path.end_with?('bobs_page.html')
          '<!DOCTYPE html><html><head><title>bob</title></head><body>bob</body></html>'
        else
          '<!DOCTYPE html><html><head><title>host</title></head><body><div id="log"></div></body></html>'
        end
      [200, {'content-type' => 'text/html'}, [body]]
    end
    s = Capybara::Session.new(:simulated, app)
    s.visit '/host/test.html'
    s
  end

  # Drive the event loop the way the WPT runner does (drains run after each
  # evaluate_script), so deferred frame navigations + their load chains land.
  def pump(s, n = 40)
    n.times { s.evaluate_script("typeof __runLoopStep === 'function' ? __runLoopStep(50, 50, false) : null") }
  end

  it 'GET-submits a form in a nested document to a named sibling frame, excluding shadow-tree fields' do
    s = session
    s.execute_script(<<~JS)
      const host = document.createElement('iframe');
      document.body.appendChild(host);
      const d = host.contentWindow.document;
      window.__d = d;

      const tgt = document.createElement('iframe');
      tgt.src = '/res/blank.html';
      tgt.setAttribute('name', 'targetIframe');

      const form = d.createElement('form');
      form.setAttribute('target', 'targetIframe');
      form.setAttribute('method', 'GET');
      form.setAttribute('action', '/res/blank.html');
      d.body.appendChild(form);

      const root = d.createElement('div');
      form.appendChild(root);
      const sr = root.attachShadow({mode: 'open'});

      const i1 = d.createElement('input');
      i1.setAttribute('type', 'text'); i1.setAttribute('name', 'inp1'); i1.setAttribute('value', 'value1');
      form.appendChild(i1);

      const i2 = d.createElement('input');
      i2.setAttribute('type', 'text'); i2.setAttribute('name', 'inp2'); i2.setAttribute('value', 'value2');
      sr.appendChild(i2);    // in the shadow tree → must NOT be submitted

      window.__tgt = tgt;
      d.body.appendChild(tgt);
    JS
    pump(s)
    s.execute_script('window.__d.querySelector("form").submit();')
    pump(s)

    url = s.evaluate_script('window.__tgt.contentWindow.document.URL')
    expect(url).to include('inp1=value1')      # light-tree control submitted
    expect(url).not_to include('inp2=value2')  # shadow-tree control excluded
  end

  it 'replaces (not appends to) a pre-existing query in the action on a GET submit' do
    s = session
    s.execute_script(<<~JS)
      const host = document.createElement('iframe');
      document.body.appendChild(host);
      const d = host.contentWindow.document;

      const tgt = document.createElement('iframe');
      tgt.src = '/res/blank.html';
      tgt.setAttribute('name', 'targetIframe');

      const form = d.createElement('form');
      form.setAttribute('target', 'targetIframe');
      form.setAttribute('method', 'GET');
      form.setAttribute('action', '/res/blank.html?stale=1');   // pre-existing query must be dropped
      d.body.appendChild(form);

      const i = d.createElement('input');
      i.setAttribute('name', 'fresh'); i.setAttribute('value', 'ok');
      form.appendChild(i);

      window.__tgt = tgt;
      d.body.appendChild(tgt);
    JS
    pump(s)
    s.execute_script('window.__d_unused = null; document.querySelector("iframe").contentWindow.document.querySelector("form").submit();')
    pump(s)

    url = s.evaluate_script('window.__tgt.contentWindow.document.URL')
    expect(url).to include('fresh=ok')
    expect(url).not_to include('stale=1')   # HTML "mutate action URL": GET replaces the query
  end

  it 'navigates the nested document itself on a self-targeted (no target) GET form submit' do
    s = session
    s.execute_script(<<~JS)
      const host = document.createElement('iframe');
      document.body.appendChild(host);
      window.__host = host;
      const d = host.contentWindow.document;

      const form = d.createElement('form');     // no target → submits to its own context
      form.setAttribute('method', 'GET');
      form.setAttribute('action', '/res/blank.html');
      d.body.appendChild(form);

      const i = d.createElement('input');
      i.setAttribute('name', 'q'); i.setAttribute('value', 'self');
      form.appendChild(i);
    JS
    pump(s)
    s.execute_script('window.__host.contentWindow.document.querySelector("form").submit();')
    pump(s)

    # The nested document itself navigated to action?q=self.
    expect(s.evaluate_script('window.__host.contentWindow.document.URL')).to include('q=self')
  end

  it 'navigates the nested document itself on a self-targeted link click, discarding its descendant frames' do
    s = session
    s.execute_script(<<~JS)
      const host = document.createElement('iframe');
      document.body.appendChild(host);
      const d = host.contentWindow.document;

      const tgt = document.createElement('iframe');
      tgt.src = '/res/blank.html';
      tgt.setAttribute('name', 'targetIframe');
      d.body.appendChild(tgt);
      window.__tgt = tgt;

      const link = d.createElement('a');
      link.setAttribute('href', '/res/bobs_page.html');   // no target → navigates d itself
      link.textContent = 'go';
      d.body.appendChild(link);
      window.__link = link;
    JS
    pump(s)
    expect(s.evaluate_script('window.__tgt.contentWindow ? "win" : "null"')).to eq('win')

    s.execute_script('window.__link.click();')
    pump(s)

    # d reloaded → the descendant targetIframe's browsing context is discarded.
    expect(s.evaluate_script('window.__tgt.contentWindow')).to be_nil
  end

  it 'keeps a self-targeted base[target] inside a shadow tree inert (link still navigates its own context)' do
    s = session
    s.execute_script(<<~JS)
      const host = document.createElement('iframe');
      document.body.appendChild(host);
      const d = host.contentWindow.document;

      const tgt = document.createElement('iframe');
      tgt.src = '/res/blank.html';
      tgt.setAttribute('name', 'targetIframe');
      d.body.appendChild(tgt);
      window.__tgt = tgt;

      const link = d.createElement('a');
      link.setAttribute('href', '/res/bobs_page.html');
      d.body.appendChild(link);
      window.__link = link;

      const root = d.createElement('div');
      d.body.appendChild(root);
      const sr = root.attachShadow({mode: 'open'});
      const base = d.createElement('base');
      base.setAttribute('target', 'targetIframe');   // shadow-tree base must be inert
      sr.appendChild(base);
    JS
    pump(s)
    s.execute_script('window.__link.click();')
    pump(s)

    # The shadow base[target] did NOT redirect the link to targetIframe, so the
    # nested doc navigated itself and its descendant frame was discarded.
    expect(s.evaluate_script('window.__tgt.contentWindow')).to be_nil
  end
end
