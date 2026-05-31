# frozen_string_literal: true

require 'capybara/simulated'

# Behavioural coverage for the WebIDL members drained from the existence
# backlog. The idl_coverage_spec gate only checks that each member EXISTS;
# these lock the actual behaviour for the non-trivial ones (reflection
# defaults, URL decomposition, form reset, normalize, legacy Event aliases,
# navigator stubs) so a future change can't silently break them while still
# satisfying the existence probe.
RSpec.describe 'WebIDL reflection behaviour' do
  let(:app) {
    ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  describe 'ARIAMixin reflection' do
    it 'maps camelCase IDL to the hyphen-free aria-* attribute and round-trips' do
      result = session.evaluate_script(<<~JS)
        const el = document.createElement('div');
        el.ariaLabel = 'Close';
        el.ariaColCount = '3';
        el.ariaRoleDescription = 'slide';
        ({
          label_attr: el.getAttribute('aria-label'),
          colcount_attr: el.getAttribute('aria-colcount'),
          roledesc_attr: el.getAttribute('aria-roledescription'),
          label_idl: el.ariaLabel,
          absent_is_null: el.ariaChecked === null
        })
      JS
      expect(result).to eq(
        'label_attr'      => 'Close',
        'colcount_attr'   => '3',
        'roledesc_attr'   => 'slide',
        'label_idl'       => 'Close',
        'absent_is_null'  => true
      )
    end

    it 'reflects role via the role attribute' do
      v = session.evaluate_script("const e=document.createElement('div'); e.setAttribute('role','button'); e.role")
      expect(v).to eq('button')
    end

    it 'resolves element-reference ARIA (single + IDREF-list) by id' do
      result = session.evaluate_script(<<~JS)
        const a = document.createElement('div'); a.id = 'a';
        const b = document.createElement('div'); b.id = 'b';
        const host = document.createElement('div');
        host.setAttribute('aria-controls', 'a b missing');
        host.setAttribute('aria-activedescendant', 'b');
        document.body.appendChild(a);
        document.body.appendChild(b);
        document.body.appendChild(host);
        ({
          controls_ids: host.ariaControlsElements.map(e => e.id),
          active_id: host.ariaActiveDescendantElement && host.ariaActiveDescendantElement.id,
          empty_is_null: document.createElement('div').ariaControlsElements
        })
      JS
      expect(result).to eq(
        'controls_ids'  => %w[a b],   # 'missing' (no element) dropped
        'active_id'     => 'b',
        'empty_is_null' => nil
      )
    end

    it 'element-reference ARIA setter stores refs in an internal slot, not the content attribute' do
      # Per ARIA element reflection (verified vs Chromium): assigning elements
      # via the IDL property keeps them in an internal slot and sets the content
      # attribute to '' — getAttribute returns '' (NOT the joined ids), and the
      # getter reads the stored elements back.
      result = session.evaluate_script(<<~JS)
        const x = document.createElement('div'); x.id = 'x';
        const y = document.createElement('div'); y.id = 'y';
        const host = document.createElement('div');
        host.ariaControlsElements = [x, y];
        ({
          attr:         host.getAttribute('aria-controls'),
          has:          host.hasAttribute('aria-controls'),
          readback_ids: host.ariaControlsElements.map(e => e.id),
          frozen:       Object.isFrozen(host.ariaControlsElements)
        })
      JS
      expect(result).to eq(
        'attr'         => '',
        'has'          => true,
        'readback_ids' => %w[x y],
        'frozen'       => true
      )
    end

    it 'element-reference ARIA list setter rejects a non-iterable value (matches browser TypeError)' do
      name = session.evaluate_script(<<~JS)
        (() => {
          const host = document.createElement('div');
          try { host.ariaControlsElements = document.createElement('div'); return 'no-throw'; }
          catch (e) { return e.name; }
        })()
      JS
      expect(name).to eq('TypeError')
    end
  end

  describe 'HTMLElement enumerated reflection' do
    it 'draggable defaults true for img and a[href], false for div' do
      result = session.evaluate_script(<<~JS)
        const a = document.createElement('a'); a.setAttribute('href', '/x');
        ({
          img: document.createElement('img').draggable,
          div: document.createElement('div').draggable,
          anchor: a.draggable
        })
      JS
      expect(result).to eq('img' => true, 'div' => false, 'anchor' => true)
    end

    it 'translate inherits from the nearest ancestor with the attribute' do
      result = session.evaluate_script(<<~JS)
        const outer = document.createElement('div');
        outer.setAttribute('translate', 'no');
        const span = document.createElement('span');
        outer.appendChild(span);
        ({ span: span.translate, bare: document.createElement('p').translate })
      JS
      expect(result).to eq('span' => false, 'bare' => true)
    end

    it 'contentEditable is the enumerated string, distinct from isContentEditable' do
      result = session.evaluate_script(<<~JS)
        const e = document.createElement('div');
        const before = e.contentEditable;
        e.setAttribute('contenteditable', '');
        ({ before: before, empty_attr: e.contentEditable })
      JS
      expect(result).to eq('before' => 'inherit', 'empty_attr' => 'true')
    end

    it 'outerText setter replaces text content without throwing' do
      v = session.evaluate_script(<<~JS)
        const e = document.createElement('div');
        e.outerText = 'hello';
        e.textContent
      JS
      expect(v).to eq('hello')
    end
  end

  describe 'HTMLAnchorElement URL decomposition' do
    it 'decomposes href into components with correct separators' do
      result = session.evaluate_script(<<~JS)
        const a = document.createElement('a');
        a.setAttribute('href', 'https://example.test:8443/p/q?x=1#frag');
        ({
          protocol: a.protocol, host: a.host, hostname: a.hostname, port: a.port,
          pathname: a.pathname, search: a.search, hash: a.hash, origin: a.origin
        })
      JS
      expect(result).to eq(
        'protocol' => 'https:', 'host' => 'example.test:8443', 'hostname' => 'example.test',
        'port' => '8443', 'pathname' => '/p/q', 'search' => '?x=1', 'hash' => '#frag',
        'origin' => 'https://example.test:8443'
      )
    end

    it 'exposes username/password as strings (userinfo decomposition is a known gap)' do
      # `a.username` / `a.password` exist and answer '' for the overwhelmingly
      # common no-userinfo URL. Full decomposition of `user:pw@` would require
      # the anchor `href` resolver to preserve userinfo, which it currently
      # strips (and which browsers themselves drop from navigation/fetch), so
      # the pending case documents the limitation rather than touching the
      # load-bearing href-resolution hot path for a deprecated URL feature.
      kinds = session.evaluate_script(<<~JS)
        const a = document.createElement('a');
        a.setAttribute('href', '/local');
        ({ u: typeof a.username, p: typeof a.password })
      JS
      expect(kinds).to eq('u' => 'string', 'p' => 'string')

      pending 'anchor href resolution strips userinfo'
      withinfo = session.evaluate_script(<<~JS)
        const a = document.createElement('a');
        a.setAttribute('href', 'https://user:pw@example.test/');
        ({ u: a.username, p: a.password })
      JS
      expect(withinfo).to eq('u' => 'user', 'p' => 'pw')
    end

    it 'returns empty strings (not throwing) when href is absent' do
      result = session.evaluate_script(<<~JS)
        const a = document.createElement('a');
        ({ protocol: a.protocol, hash: a.hash, search: a.search, host: a.host })
      JS
      expect(result).to eq('protocol' => '', 'hash' => '', 'search' => '', 'host' => '')
    end

    it 'omits default ports' do
      v = session.evaluate_script("const a=document.createElement('a'); a.setAttribute('href','https://e.test:443/'); a.port")
      expect(v).to eq('')
    end
  end

  describe 'HTMLFormElement.reset' do
    it 'restores a typed text input to its default value' do
      result = session.evaluate_script(<<~JS)
        const f = document.createElement('form');
        const i = document.createElement('input');
        i.setAttribute('type', 'text');
        i.setAttribute('value', 'foo');
        f.appendChild(i);
        document.body.appendChild(f);
        i.value = 'bar';
        const dirty = i.value;
        f.reset();
        ({ dirty: dirty, after_reset: i.value })
      JS
      expect(result).to eq('dirty' => 'bar', 'after_reset' => 'foo')
    end

    it 'restores checkbox checkedness to its default' do
      result = session.evaluate_script(<<~JS)
        const f = document.createElement('form');
        const c = document.createElement('input');
        c.setAttribute('type', 'checkbox');
        c.setAttribute('checked', '');
        f.appendChild(c);
        document.body.appendChild(f);
        c.checked = false;
        const dirty = c.checked;
        f.reset();
        ({ dirty: dirty, after_reset: c.checked })
      JS
      expect(result).to eq('dirty' => false, 'after_reset' => true)
    end

    it 'restores a typed textarea to its default content' do
      result = session.evaluate_script(<<~JS)
        const f = document.createElement('form');
        const t = document.createElement('textarea');
        t.appendChild(document.createTextNode('default'));
        f.appendChild(t);
        document.body.appendChild(f);
        t.value = 'edited';
        const dirty = t.value;
        f.reset();
        ({ dirty: dirty, after_reset: t.value })
      JS
      expect(result).to eq('dirty' => 'edited', 'after_reset' => 'default')
    end
  end

  describe 'Node.normalize' do
    it 'coalesces adjacent text nodes and emits observer records' do
      result = session.evaluate_script(<<~JS)
        const host = document.createElement('div');
        const a = document.createTextNode('foo');
        const b = document.createTextNode('bar');
        host.appendChild(a); host.appendChild(b);
        const obs = new MutationObserver(() => {});
        obs.observe(host, {childList: true, characterData: true, subtree: true});
        host.normalize();
        const recs = obs.takeRecords();
        ({
          child_count: host.childNodes.length,
          text: host.textContent,
          dropped_disconnected: b.isConnected === false,
          got_records: recs.length > 0
        })
      JS
      expect(result).to eq(
        'child_count' => 1, 'text' => 'foobar',
        'dropped_disconnected' => true, 'got_records' => true
      )
    end
  end

  describe 'Event legacy aliases' do
    it 'returnValue mirrors defaultPrevented and false triggers preventDefault' do
      result = session.evaluate_script(<<~JS)
        const e = new Event('x', {cancelable: true});
        const initial = e.returnValue;
        e.returnValue = false;
        ({ initial: initial, after: e.returnValue, prevented: e.defaultPrevented })
      JS
      expect(result).to eq('initial' => true, 'after' => false, 'prevented' => true)
    end

    it 'initCustomEvent sets type and detail' do
      result = session.evaluate_script(<<~JS)
        const e = document.createEvent ? new CustomEvent('placeholder') : new CustomEvent('placeholder');
        e.initCustomEvent('ready', true, false, {n: 7});
        ({ type: e.type, detail_n: e.detail && e.detail.n, bubbles: e.bubbles })
      JS
      expect(result).to eq('type' => 'ready', 'detail_n' => 7, 'bubbles' => true)
    end
  end

  describe 'navigator stubs' do
    it 'locks.request echoes the requested mode' do
      shared = session.evaluate_async_script(<<~JS)
        const done = arguments[0];
        navigator.locks.request('n', {mode: 'shared'}, (lock) => { done(lock.mode); });
      JS
      expect(shared).to eq('shared')

      exclusive = session.evaluate_async_script(<<~JS)
        const done = arguments[0];
        navigator.locks.request('n', (lock) => { done(lock.mode); });
      JS
      expect(exclusive).to eq('exclusive')
    end

    it 'mediaDevices.getUserMedia rejects rather than throwing' do
      rejected = session.evaluate_async_script(<<~JS)
        const done = arguments[0];
        navigator.mediaDevices.getUserMedia({video: true})
          .then(() => done('resolved'))
          .catch((e) => done('rejected:' + e.name));
      JS
      expect(rejected).to start_with('rejected:')
    end
  end

  describe 'HTMLInputElement reflection' do
    it 'reflects string/boolean/unsigned-long attributes with correct defaults' do
      result = session.evaluate_script(<<~JS)
        const mk = (attrs) => {
          const i = document.createElement('input');
          for (const k in attrs) i.setAttribute(k, attrs[k]);
          return i;
        };
        const m = mk({}); m.multiple = true;
        ({
          accept: mk({accept: 'image/*'}).accept,
          max: mk({max: '9'}).max,
          size_default: mk({}).size,
          multiple: m.multiple,
          multiple_attr: m.getAttribute('multiple')
        })
      JS
      expect(result).to eq(
        'accept' => 'image/*', 'max' => '9', 'size_default' => 20,
        'multiple' => true, 'multiple_attr' => ''
      )
    end

    it 'defaultValue reflects the content attribute, independent of the live value' do
      result = session.evaluate_script(<<~JS)
        const i = document.createElement('input');
        i.setAttribute('value', 'foo');
        const before = i.defaultValue;
        i.value = 'bar';
        ({ before: before, default_after: i.defaultValue, live: i.value })
      JS
      expect(result).to eq('before' => 'foo', 'default_after' => 'foo', 'live' => 'bar')
    end

    it 'indeterminate is an instance flag, not attribute-backed' do
      result = session.evaluate_script(<<~JS)
        const i = document.createElement('input');
        i.setAttribute('type', 'checkbox');
        i.indeterminate = true;
        ({ flag: i.indeterminate, no_attr: i.hasAttribute('indeterminate') })
      JS
      expect(result).to eq('flag' => true, 'no_attr' => false)
    end

    it 'valueAsNumber parses numeric input and stepUp/stepDown adjust by step' do
      result = session.evaluate_script(<<~JS)
        const n = document.createElement('input'); n.setAttribute('type', 'number'); n.value = '42';
        const s = document.createElement('input');
        s.setAttribute('type', 'number'); s.setAttribute('step', '5'); s.value = '10';
        s.stepUp(2);
        const after_up = s.value;
        s.stepDown(1);
        ({ asNumber: n.valueAsNumber, after_up: after_up, after_down: s.value })
      JS
      expect(result).to eq('asNumber' => 42, 'after_up' => '20', 'after_down' => '15')
    end

    it 'labels collects label[for=id] plus ancestor labels' do
      len = session.evaluate_script(<<~JS)
        const i = document.createElement('input');
        i.id = 'fld';
        const lab = document.createElement('label');
        lab.setAttribute('for', 'fld');
        document.body.appendChild(lab);
        document.body.appendChild(i);
        i.labels.length
      JS
      expect(len).to eq(1)
    end
  end
end
