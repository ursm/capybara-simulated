# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# DOM "clone a node": what a copy of an element carries — its attributes, exactly, and the state the cloning steps copy
# (cloning.rs). Every expectation is Chrome's.
RSpec.describe 'cloneNode' do
  it "carries an element's attributes and the state its cloning steps copy" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><body><div id=r><input id=t value=a><input id=c type=checkbox checked><svg><a xlink:href="#x"></a></svg><button onclick="window.clicked = (window.clicked || 0) + 1">b</button><p id=p>p</p></div><script>window.ran = (window.ran || 0) + 1</script>
    HTML
    expect(s.evaluate_script(<<~JS)).to eq(['typed', 'a', false, true, 'http://www.w3.org/1999/xlink', 'xlink', 1, 1, 3, 0xD800])
      (() => {
        const t = document.getElementById('t'), c = document.getElementById('c');
        t.value = 'typed'; c.checked = false; c.indeterminate = true;
        document.getElementById('p').setAttribute('data-u', 'a\\uD800b');
        const r = document.getElementById('r').cloneNode(true);
        const [t2, c2] = r.querySelectorAll('input');
        const a2 = r.querySelector('a'), p2 = r.querySelector('p');
        r.querySelector('button').click();
        document.body.appendChild(document.querySelector('script').cloneNode(true));
        const u = p2.getAttribute('data-u');
        return [t2.value, t2.getAttribute('value'), c2.checked, c2.indeterminate, a2.attributes[0].namespaceURI, a2.attributes[0].prefix,
                window.clicked, window.ran, u.length, u.charCodeAt(1)];
      })()
    JS
  end

  # An image's copy loads its source as its attributes are appended — inserted or not.
  it "loads an image's copy" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><body><img id=i src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
    HTML
    s.execute_script(<<~JS)
      const c = document.getElementById('i').cloneNode(true);
      c.onload = () => { window.R = ['load', c.naturalWidth, c.complete]; };
    JS
    expect(s.evaluate_script('window.R')).to eq(['load', 1, true])
  end

  # An image in template contents loads nothing — its document is not fully active — not as parsed, nor as cloned; its
  # copy loads once inserted into the page, or imported into it, the onload content attribute running in its document
  # (Chrome).
  it 'loads a template image once it is in the page' do
    log = []
    png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='.unpack1('m0')
    html = <<~HTML
      <!doctype html><meta charset=utf-8><body><template id=t><img src="/tpl.png" onload="R.push('attr:' + (this.ownerDocument === document))"></template>
      <script>window.R = []; window.f = document.getElementById('t').content.cloneNode(true);</script>
    HTML
    app = ->(env) {
      log << env['PATH_INFO']
      env['PATH_INFO'].end_with?('.png') ? [200, {'content-type' => 'image/png'}, [png]] : [200, {'content-type' => 'text/html'}, [html]]
    }
    s = simulated_session(app).tap {|session| session.visit '/' }
    expect(log).to eq(['/'])
    s.execute_script('document.body.append(f)')
    expect(s.evaluate_script('window.R')).to eq(['attr:true'])
    expect(log).to eq(['/', '/tpl.png'])
    # (…and as imported, `document.importNode(template.content, true)`, which the page's document owns as it is made)
    s.execute_script("window.R = []; document.body.append(document.importNode(document.getElementById('t').content, true))")
    expect(s.evaluate_script('window.R')).to eq(['attr:true'])
  end

  # The engine makes a deep copy's nodes, their objects only when the page asks (cloning.rs): a traversal's filter is
  # handed each one, a detached copy's radio group unchecks as any, an image's copy of every kind — an image button, an
  # SVG image — loads, and a name with a lone surrogate keeps it. Chrome's.
  it "hands over the nodes of a copy the page has not touched" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><body><div id=d><p><!--c-->t</p></div>
    HTML
    expect(s.evaluate_script(<<~'JS')).to eq(['P #comment #text', 'false,true,1', true])
      (() => {
        const copy = document.getElementById('d').cloneNode(true), seen = [];
        const walker = document.createTreeWalker(copy, NodeFilter.SHOW_ALL, { acceptNode: (n) => { seen.push(n.nodeName); return NodeFilter.FILTER_ACCEPT; } });
        while (walker.nextNode());
        const d = document.getElementById('d');
        d.innerHTML = '<input type=radio name=g checked><input type=radio name=g>';
        const group = d.cloneNode(true), radios = group.querySelectorAll('input');
        radios[1].checked = true;
        const svg = 'http://www.w3.org/2000/svg';
        d.innerHTML = '<input type=image src="data:,">';
        d.appendChild(document.createElementNS(svg, 'svg')).appendChild(document.createElementNS(svg, 'image')).setAttribute('href', 'data:,');
        window.loads = [];
        const images = d.cloneNode(true);
        for (const n of images.querySelectorAll('input, image')) for (const t of ['load', 'error']) n.addEventListener(t, () => loads.push(n.localName));
        document.body.appendChild(images);
        const odd = document.createElement('div');
        odd.appendChild(document.createElementNS('urn:x', 'a\uD800b'));
        return [seen.join(' '), [radios[0].checked, radios[1].checked, group.querySelectorAll(':checked').length].join(), odd.cloneNode(true).firstChild.localName === 'a\uD800b'];
      })()
    JS
  end

  # The engine clones a shadow host's clonable shadow root with it (cloning.rs `clone_shadow_root`), whatever `deep`
  # says: its tree copied, a custom element in it upgraded, the copy declarative as the source was — so attachShadow
  # reuses it — and a range's clone carries it too. Chrome: ["<p>in</p><x-el></x-el>", true, "reused", same].
  it 'clones a clonable shadow root with its host' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><meta charset=utf-8><div id=h><template shadowrootmode=open shadowrootclonable><p>in</p><x-el></x-el></template></div>
    HTML
    expect(s.evaluate_script(<<~'JS')).to eq(['<p>in</p><x-el></x-el>', true, 'reused', '<p>in</p><x-el></x-el>'])
      (() => {
        customElements.define('x-el', class extends HTMLElement { constructor() { super(); this.made = true; } });
        const h = document.getElementById('h');
        const c = h.cloneNode(false);
        let reuse;
        try { reuse = c.attachShadow({mode: 'open'}) === c.shadowRoot ? 'reused' : 'other'; } catch (e) { reuse = e.name; }
        const d = h.cloneNode(false);
        const range = document.createRange();
        range.selectNode(h);
        const f = range.cloneContents();
        return [d.shadowRoot.innerHTML, d.shadowRoot.querySelector('x-el').made === true, reuse, f.firstChild.shadowRoot.innerHTML];
      })()
    JS
  end

  # The copies' custom elements are upgraded in the order the clone makes them — a host, its light tree, then its shadow
  # tree (DOM "clone a node" steps 5 and 6) — by the realm whose document they are in, whichever realm's code clones
  # them. Chrome: ["h:Y1", "l:YL", "l:YLL", "s:YLS", "s:YS"], and ["ms", "ms"] for a frame's range over the page.
  it 'upgrades a clone\'s custom elements in the order it makes them, by their own realm' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><meta charset=utf-8><iframe id=f srcdoc="<!DOCTYPE html><body>x</body>"></iframe>
    HTML
    s.evaluate_async_script(<<~'JS')
      const done = arguments[0];
      const ready = () => document.getElementById('f').contentDocument?.readyState === 'complete' ? done() : setTimeout(ready, 10);
      ready();
    JS
    expect(s.evaluate_script(<<~'JS')).to eq([%w[h:Y1 l:YL l:YLL s:YLS s:YS], %w[ms ms]])
      (() => {
        const log = [];
        for (const [name, tag] of [['x-h', 'h'], ['x-l', 'l'], ['x-s', 's']]) {
          customElements.define(name, class extends HTMLElement { constructor() { super(); log.push(tag + ':' + this.id); } });
        }
        const y = document.createElement('div');
        y.innerHTML = '<x-h id=Y1><x-l id=YL><x-l id=YLL></x-l></x-l></x-h>';
        y.firstChild.attachShadow({mode: 'open', clonable: true}).innerHTML = '<x-s id=YS></x-s>';
        y.firstChild.firstChild.attachShadow({mode: 'open', clonable: true}).innerHTML = '<x-s id=YLS></x-s>';
        log.length = 0;
        y.cloneNode(true);
        const order = log.splice(0);
        customElements.define('x-m', class extends HTMLElement { constructor() { super(); log.push('ms'); } });
        const host = document.body.appendChild(document.createElement('div'));
        host.innerHTML = '<b>q</b><x-m></x-m>';
        host.attachShadow({mode: 'open', clonable: true}).innerHTML = '<x-m></x-m><slot></slot>';
        log.length = 0;
        const range = document.getElementById('f').contentDocument.createRange();
        range.selectNode(host);
        range.cloneContents();
        return [order, log];
      })()
    JS
  end
end
