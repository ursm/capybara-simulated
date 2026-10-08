# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# IntersectionObserver, ResizeObserver and PerformanceObserver, with their entries, sizes and entry lists, generated from
# their IDL: arguments required and converted, brands checked, state in slots. The figures are headless Chrome's, but for two the spec
# decides: IntersectionObserverEntry has a constructor (the IDL's; Chrome's is illegal), and trackVisibility clamps a
# delay below 100 to 100 (the spec's "set delay to 100"; Chrome throws NotSupportedError); and so do a margin's absolute
# units, an entry for an intersecting state that changed alone, and observe({entryTypes, buffered}) refused — each where
# its test says.
RSpec.describe 'Observer bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/boxes'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><meta charset="utf-8"><style>
            #a { width: 100px; height: 50px; padding: 3px 5px; border: 2px solid; }
            #v { writing-mode: vertical-rl; width: 30px; height: 70px; padding: 1px; }
            #n { display: none; }
            #z { width: 0; height: 0; }
            #t { display: table; width: 40px; height: 20px; padding: 2px; border: 1px solid; }
            #x { width: 10px; height: 10px; transform: scale(3); }
          </style>
          <body><div id=a></div><span id=s>text here</span><div id=v></div><div id=n></div><div id=z></div><div id=t></div><div id=x></div>
        HTML
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
      end
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what the IntersectionObserver IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const o = new IntersectionObserver(() => {}, {rootMargin: '5px 10%', scrollMargin: '3px', threshold: [0.5, 0, 1]});
        const entry = new IntersectionObserverEntry({
          time: 1, rootBounds: null, boundingClientRect: {width: 3}, intersectionRect: {}, isIntersecting: true,
          isVisible: false, intersectionRatio: 0.5, target: document.body
        });
        return [
          error(() => new IntersectionObserver()),
          error(() => new IntersectionObserver(1)),
          error(() => new IntersectionObserver(() => {}, {rootMargin: '5em'})),
          error(() => new IntersectionObserver(() => {}, {scrollMargin: '5em'})),
          error(() => new IntersectionObserver(() => {}, {threshold: 2})),
          error(() => o.observe(document)),
          error(() => IntersectionObserver.prototype.observe.call({}, document.body)),
          new IntersectionObserver(() => {}, {threshold: []}).thresholds,
          [o.rootMargin, o.scrollMargin, o.thresholds, Object.isFrozen(o.thresholds), o.root, o.delay, o.trackVisibility],
          new IntersectionObserver(() => {}, {trackVisibility: true, delay: 50}).delay,
          [entry.time, entry.rootBounds, entry.boundingClientRect.width, entry.boundingClientRect instanceof DOMRectReadOnly, entry.target === document.body],
          Object.getOwnPropertyNames(IntersectionObserver.prototype).sort()
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'IntersectionObserver': 1 argument required, but only 0 present.",
      "TypeError: Failed to construct 'IntersectionObserver': parameter 1 is not of type 'Function'.",
      "SyntaxError: Failed to construct 'IntersectionObserver': rootMargin must be specified in pixels or percent.",
      "SyntaxError: Failed to construct 'IntersectionObserver': scrollMargin must be specified in pixels or percent.",
      "RangeError: Failed to construct 'IntersectionObserver': Threshold values must be numbers between 0 and 1",
      "TypeError: Failed to execute 'observe' on 'IntersectionObserver': parameter 1 is not of type 'Element'.",
      'TypeError: Illegal invocation',
      [0],
      ['5px 10% 5px 10%', '3px 3px 3px 3px', [0, 0.5, 1], true, nil, 0, false],
      100,
      [1, nil, 3, true, true],
      %w[constructor delay disconnect observe root rootMargin scrollMargin takeRecords thresholds trackVisibility unobserve]
    ])
  end

  # "Parse a margin": CSS tokens — a comment dropped, a unit case-insensitive, an absolute one converted (the spec's
  # "absolute length dimension token"; Chrome takes px alone), a bare number refused — and none at all 0px. Chrome's
  # figures, but for `1in` and `.5px`, which Chrome truncates to 0px.
  it 'parses a margin as CSS tokens' do
    got = session.evaluate_script(<<~JS)
      ['', ' ', '10PX', '+5px', '.5px', '1e1px', '-0px', '5px/**/6px', '1in', '10', '0', '5px,6px', '1px 2px 3px 4px 5px'].map((m) => {
        try { return new IntersectionObserver(() => {}, {rootMargin: m, scrollMargin: m}).rootMargin; } catch (e) { return e.name; }
      })
    JS
    expect(got).to eq([
      '0px 0px 0px 0px',
      '0px 0px 0px 0px',
      '10px 10px 10px 10px',
      '5px 5px 5px 5px',
      '0.5px 0.5px 0.5px 0.5px',
      '10px 10px 10px 10px',
      '0px 0px 0px 0px',
      '5px 6px 5px 6px',
      '96px 96px 96px 96px',
      'SyntaxError',
      'SyntaxError',
      'SyntaxError',
      'SyntaxError'
    ])
  end

  # "Compute the visibility" (Intersection Observer v2): a covered corner, a rotation (by `rotate` as much as by
  # `transform`) are not visible; a box partly off the viewport, a proportional upscaling, one under a wholly transparent
  # box and one beside what an `overflow: hidden` box clips away are. Chrome's figures.
  it 'computes an IntersectionObserver target visible as the spec does' do
    session.execute_script(<<~JS)
      document.body.innerHTML = `
        <div id=a style="position: absolute; left: 10px; top: 10px; width: 100px; height: 100px"></div>
        <div style="position: absolute; left: 100px; top: 100px; width: 20px; height: 20px"></div>
        <div id=b style="position: absolute; left: -60px; top: 200px; width: 100px; height: 100px"></div>
        <div id=c style="position: absolute; left: 200px; top: 10px; width: 100px; height: 100px; rotate: 45deg"></div>
        <div id=d style="position: absolute; left: 400px; top: 200px; width: 50px; height: 50px; transform: scale(2)"></div>
        <div id=e style="position: absolute; left: 10px; top: 400px; width: 50px; height: 50px"></div>
        <div style="position: absolute; left: 10px; top: 400px; width: 50px; height: 50px; opacity: 0"></div>
        <div id=f style="position: absolute; left: 100px; top: 400px; width: 50px; height: 50px"></div>
        <div style="position: absolute; left: 160px; top: 400px; width: 10px; height: 10px; overflow: hidden">
          <div style="margin-left: -100px; width: 200px; height: 200px"></div>
        </div>`;
      window.got = {};
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) window.got[e.target.id] = e.isVisible;
      }, {trackVisibility: true, delay: 100});
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) io.observe(document.getElementById(id));
    JS
    expect(poll_until { session.evaluate_script('Object.keys(window.got).length === 6 && window.got') })
      .to eq('a' => false, 'b' => true, 'c' => false, 'd' => true, 'e' => true, 'f' => true)
  end

  # The effective transformation matrix unflattened: any z in it — a `translateZ`, a 3D scale, an ancestor's, a
  # perspective — makes a target not visible, a z that comes to nothing does not; opacity on a box-less ancestor applies
  # to nothing; the root element is visible. Chrome's figures.
  it 'computes visibility from the unflattened matrix, boxes, and the root' do
    session.execute_script(<<~JS)
      document.body.innerHTML = `
        <div id=z style="transform: translateZ(10px); width: 20px; height: 20px"></div>
        <div id=s3 style="transform: scale3d(2, 2, 3); width: 20px; height: 20px; margin: 20px"></div>
        <div style="transform: translateZ(5px)"><div id=up style="width: 20px; height: 20px"></div></div>
        <div style="perspective: 100px"><div id=p style="transform: scale(2); width: 20px; height: 20px; margin: 20px"></div></div>
        <div id=z0 style="transform: translateZ(0); width: 20px; height: 20px"></div>
        <div id=t3 style="transform: translate3d(5px, 0, 0); width: 20px; height: 20px"></div>
        <div style="display: contents; opacity: .5"><div id=dc style="width: 20px; height: 20px"></div></div>`;
      window.got = {};
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) window.got[e.target.id || e.target.localName] = e.isVisible;
      }, {trackVisibility: true, delay: 100});
      for (const id of ['z', 's3', 'up', 'p', 'z0', 't3', 'dc']) io.observe(document.getElementById(id));
      io.observe(document.documentElement);
    JS
    expect(poll_until { session.evaluate_script('Object.keys(window.got).length === 8 && window.got') }).to eq(
      'z' => false, 's3' => false, 'up' => false, 'p' => false, 'z0' => true, 't3' => true, 'dc' => true, 'html' => true
    )
  end

  # A change of visibility alone notifies — an overlay laid over a target and taken away — and no update of a target
  # comes within its observer's delay of the last.
  it 'notifies an IntersectionObserver of visibility, no more often than its delay' do
    session.execute_script(<<~JS)
      document.body.innerHTML = '<div id=t style="width: 100px; height: 100px"></div>';
      window.got = [];
      new IntersectionObserver((entries) => {
        for (const e of entries) window.got.push([e.isVisible, Math.round(e.time)]);
      }, {trackVisibility: true, delay: 1000}).observe(document.getElementById('t'));
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 1 && window.got.map((g) => g[0])') }).to eq([true])
    session.execute_script(<<~JS)
      const cover = document.createElement('div');
      cover.id = 'cover';
      cover.style.cssText = 'position: absolute; left: 0; top: 0; width: 50px; height: 50px';
      document.body.append(cover);
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 2 && window.got.map((g) => g[0])') }).to eq([true, false])
    session.execute_script("document.getElementById('cover').remove()")
    got = poll_until { session.evaluate_script('window.got.length === 3 && window.got') }
    expect(got.map(&:first)).to eq([true, false, true])
    expect(got.each_cons(2).map {|a, b| b[1] - a[1] }).to all(be >= 1000)
  end

  # The notify list is every observer with entries queued: one disconnected between the update and the task — by a timer
  # an animation frame callback set, which runs before it — still gets the entries it had (the spec; Chrome drops them),
  # and never again with a later update's.
  it 'notifies an IntersectionObserver of the entries it had when it was disconnected' do
    session.execute_script(<<~JS)
      window.got = [];
      window.io = new IntersectionObserver((entries) => window.got.push(entries.length));
      io.observe(document.body);
      requestAnimationFrame(() => setTimeout(() => { io.disconnect(); window.got.push('disconnected'); }, 0));
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 2 && window.got') }).to eq(['disconnected', 1])
    session.execute_script('window.got = []; io.observe(document.body);')
    expect(poll_until { session.evaluate_script('window.got.length === 1 && window.got') }).to eq([1])
  end

  # The platform's own tasks — an observer's notification, a timeout signal's abort — are no page timer: a page clearing
  # every id it can count to clears none of them, and the ids it is given skip none for them. Chrome: the callbacks come.
  it 'keeps the platform tasks out of reach of clearTimeout' do
    session.execute_script(<<~JS)
      window.got = [];
      const div = document.body.appendChild(document.createElement('div'));
      const signal = AbortSignal.timeout(50);
      signal.onabort = () => window.got.push('aborted');
      new PerformanceObserver(() => window.got.push('po')).observe({type: 'mark'});
      new IntersectionObserver(() => window.got.push('io')).observe(div);
      requestAnimationFrame(() => {
        performance.mark('m');
        const first = setTimeout(() => {}, 0);
        for (let i = 0; i <= first + 50; i++) clearTimeout(i);
        window.consecutive = setTimeout(() => {}, 0) === first + 1;
      });
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 3 && window.got.sort()') }).to eq(%w[aborted io po])
    expect(session.evaluate_script('window.consecutive')).to be(true)
  end

  # An idle callback's identifier is its own count: clearTimeout reaches no idle callback, nor cancelIdleCallback a
  # timer. Chrome: both count from 1, and each runs.
  it 'keeps idle callback identifiers apart from timer ids' do
    session.execute_script(<<~JS)
      window.got = [];
      const r = requestIdleCallback(() => window.got.push('idle'));
      clearTimeout(r);
      window.ids = [r];
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 1 && window.got') }).to eq(['idle'])
    session.execute_script(<<~JS)
      const t = setTimeout(() => window.got.push('timer'), 10);
      cancelIdleCallback(t);
      window.ids.push(t);
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 2 && window.got') }).to eq(%w[idle timer])
    expect(session.evaluate_script('window.ids')).to eq([1, 1])
  end

  # An exception a callback throws is reported — the window's `error` event — not swallowed.
  it 'reports what an observer callback throws' do
    session.execute_script(<<~JS)
      window.got = [];
      window.addEventListener('error', (e) => { window.got.push(e.error.message); e.preventDefault(); });
      new IntersectionObserver(() => { throw new Error('io'); }).observe(document.body);
      new ResizeObserver(() => { throw new Error('ro'); }).observe(document.body);
      new PerformanceObserver(() => { throw new Error('po'); }).observe({type: 'mark'});
      performance.mark('m');
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 3 && window.got.sort()') }).to eq(%w[io po ro])
  end

  it 'calls an IntersectionObserver back with the observer as this' do
    session.execute_script(<<~JS)
      const o = new IntersectionObserver(function (entries, observer) {
        window.got = [this === o, observer === o, entries.length, entries[0].isIntersecting, entries[0] instanceof IntersectionObserverEntry];
      });
      o.observe(document.body);
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq([true, true, 1, true, true])
  end

  it 'is what the PerformanceObserver IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const observer = () => new PerformanceObserver(() => {});
        return [
          error(() => new PerformanceObserver()),
          error(() => new PerformanceObserver(1)),
          error(() => observer().observe()),
          error(() => observer().observe({entryTypes: ['mark'], type: 'mark'})),
          error(() => { const p = observer(); p.observe({entryTypes: ['mark']}); p.observe({type: 'mark'}); }),
          error(() => { const p = observer(); p.observe({type: 'mark'}); p.observe({entryTypes: ['mark']}); }),
          error(() => observer().observe({entryTypes: ['mark'], buffered: true})),
          error(() => observer().observe({entryTypes: ['mark'], durationThreshold: 16})),
          error(() => new PerformanceObserverEntryList()),
          error(() => PerformanceObserver.prototype.takeRecords.call({})),
          [Object.isFrozen(PerformanceObserver.supportedEntryTypes), PerformanceObserver.supportedEntryTypes === PerformanceObserver.supportedEntryTypes],
          Object.getOwnPropertyNames(PerformanceObserver),
          Object.getOwnPropertyNames(PerformanceObserver.prototype).sort()
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'PerformanceObserver': 1 argument required, but only 0 present.",
      "TypeError: Failed to construct 'PerformanceObserver': parameter 1 is not of type 'Function'.",
      "TypeError: Failed to execute 'observe' on 'PerformanceObserver': An observe() call must include either entryTypes or type arguments.",
      "TypeError: Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and type arguments.",
      "InvalidModificationError: Failed to execute 'observe' on 'PerformanceObserver': This observer has performed observe({entryTypes:...}, therefore it cannot perform observe({type:...})",
      "InvalidModificationError: Failed to execute 'observe' on 'PerformanceObserver': This PerformanceObserver has performed observe({type:...}, therefore it cannot perform observe({entryTypes:...})",
      "TypeError: Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and other arguments.",
      "TypeError: Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and other arguments.",
      "TypeError: Failed to construct 'PerformanceObserverEntryList': Illegal constructor",
      'TypeError: Illegal invocation',
      [true, true],
      %w[length name prototype supportedEntryTypes],
      %w[constructor disconnect observe takeRecords]
    ])
  end

  # The callback: the entry list, the observer (and `this`), and — the first time since an observe() — the count of
  # entries dropped from a full buffer, 0; {} after that (Performance Timeline "queue the PerformanceObserver task").
  it 'calls a PerformanceObserver back with its entries and the dropped count' do
    session.execute_script(<<~JS)
      window.got = [];
      const p = new PerformanceObserver(function (list, observer, options) {
        window.got.push([list.getEntries().map((e) => e.name), this === p, observer === p, options, Object.prototype.toString.call(list)]);
        if (window.got.length === 1) setTimeout(() => performance.mark('m2'), 0);
      });
      p.observe({type: 'mark'});
      performance.mark('m1');
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 2 && window.got') }).to eq([
      [['m1'], true, true, {'droppedEntriesCount' => 0}, '[object PerformanceObserverEntryList]'],
      [['m2'], true, true, {}, '[object PerformanceObserverEntryList]']
    ])
  end

  it 'is what the ResizeObserver IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          error(() => new ResizeObserver()),
          error(() => new ResizeObserver(1)),
          error(() => new ResizeObserver(() => {}).observe(document.body, {box: 'x'})),
          error(() => new ResizeObserver(() => {}).observe(document)),
          error(() => new ResizeObserverEntry()),
          error(() => new ResizeObserverSize()),
          error(() => ResizeObserver.prototype.disconnect.call({})),
          Object.getOwnPropertyNames(ResizeObserver.prototype).sort(),
          Object.getOwnPropertyNames(ResizeObserverEntry.prototype).sort()
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'ResizeObserver': 1 argument required, but only 0 present.",
      "TypeError: Failed to construct 'ResizeObserver': parameter 1 is not of type 'Function'.",
      "TypeError: Failed to execute 'observe' on 'ResizeObserver': Failed to read the 'box' property from 'ResizeObserverOptions': The provided value 'x' is not a valid enum value of type ResizeObserverBoxOptions.",
      "TypeError: Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'.",
      "TypeError: Failed to construct 'ResizeObserverEntry': Illegal constructor",
      "TypeError: Failed to construct 'ResizeObserverSize': Illegal constructor",
      'TypeError: Illegal invocation',
      %w[constructor disconnect observe unobserve],
      %w[borderBoxSize constructor contentBoxSize contentRect devicePixelContentBoxSize target]
    ])
  end

  # The first observation of each target, at the rendering update after the animation frame callbacks — a size of 0 too,
  # the last one reported starting at (-1, -1) — in the order observed, a target observed again at the end: its content
  # rect at its padding edge, its sizes in its writing mode's axes, a non-replaced inline's and an unrendered one's 0, a
  # table's its table box's, a transform none of it. Chrome's figures.
  it 'reports the sizes a ResizeObserver observes' do
    session.visit('/boxes')
    session.execute_script(<<~JS)
      window.got = [];
      const sizes = (list) => list.map((s) => [s.inlineSize, s.blockSize]);
      const ro = new ResizeObserver(function (entries, observer) {
        for (const e of entries) {
          const r = e.contentRect;
          window.got.push([e.target.id, [r.x, r.y, r.width, r.height], sizes(e.contentBoxSize), sizes(e.borderBoxSize),
            sizes(e.devicePixelContentBoxSize), e.contentBoxSize === e.contentBoxSize, Object.isFrozen(e.borderBoxSize),
            this === ro && observer === ro]);
        }
      });
      for (const id of ['a', 's', 'v', 'n', 'z', 't', 'x']) ro.observe(document.getElementById(id));
      ro.observe(document.getElementById('a'), {box: 'border-box'});
      requestAnimationFrame(() => window.got.push('raf'));
      window.synchronous = window.got.length;
    JS
    expect(session.evaluate_script('window.synchronous')).to eq(0)
    expect(poll_until { session.evaluate_script('window.got.length === 8 && window.got') }).to eq([
      'raf',
      ['s', [0, 0, 0, 0], [[0, 0]], [[0, 0]], [[0, 0]], true, true, true],
      ['v', [1, 1, 30, 70], [[70, 30]], [[72, 32]], [[70, 30]], true, true, true],
      ['n', [0, 0, 0, 0], [[0, 0]], [[0, 0]], [[0, 0]], true, true, true],
      ['z', [0, 0, 0, 0], [[0, 0]], [[0, 0]], [[0, 0]], true, true, true],
      ['t', [2, 2, 40, 20], [[40, 20]], [[46, 26]], [[40, 20]], true, true, true],
      ['x', [0, 0, 10, 10], [[10, 10]], [[10, 10]], [[10, 10]], true, true, true],
      ['a', [5, 3, 100, 50], [[100, 50]], [[114, 60]], [[100, 50]], true, true, true]
    ])
  end

  # The loop (HTML "update the rendering"): a callback that resizes what it observes is called again in the same update
  # only for observations deeper than the shallowest it was given — the child the parent's width carries — and the
  # parent's, skipped, is reported as an ErrorEvent with no error, at the document's 0:0 (Chrome).
  it 'reports a ResizeObserver loop it cannot finish' do
    session.execute_script(<<~JS)
      document.body.innerHTML = '<div id=a style="width: 10px; height: 10px"><div id=b style="height: 5px"></div></div>';
      window.got = [];
      window.addEventListener('error', (e) => {
        window.got.push([e.message, e.error, e.filename === location.href, e.lineno, e.colno, e.cancelable, e.isTrusted]);
        e.preventDefault();
      });
      let n = 0;
      const ro = new ResizeObserver((entries) => {
        window.got.push(entries.map((e) => e.target.id + ':' + e.contentRect.width).join(','));
        if (++n === 1) document.getElementById('a').style.width = '11px';
      });
      ro.observe(document.getElementById('a'));
      ro.observe(document.getElementById('b'));
    JS
    expect(poll_until { session.evaluate_script('window.got.length >= 4 && window.got') }).to eq([
      'a:10,b:10',
      'b:11',
      ['ResizeObserver loop completed with undelivered notifications.', nil, true, 0, 0, true, true],
      'a:11'
    ])
  end

  # The entryTypes form replaces what an observer observes, the type form adds to it; a buffered type delivers the
  # entries already recorded; disconnect() forgets them all; an entry list is in startTime order, filtered by name and
  # type; takeRecords() takes what is queued.
  it 'observes the entry types a PerformanceObserver is given' do
    session.execute_script(<<~JS)
      window.got = [];
      performance.mark('early', {startTime: 5});
      const names = (list) => list.map((e) => e.name);
      const multiple = new PerformanceObserver((list) => window.got.push(['multiple', names(list.getEntries())]));
      multiple.observe({entryTypes: ['mark']});
      multiple.observe({entryTypes: ['measure']});
      const single = new PerformanceObserver((list) => window.got.push([
        'single', names(list.getEntries()), names(list.getEntriesByName('b')), names(list.getEntriesByName('b', 'measure')),
        names(list.getEntriesByType('measure'))
      ]));
      single.observe({type: 'mark', buffered: true});
      single.observe({type: 'measure'});
      const dropped = new PerformanceObserver(() => window.got.push(['dropped']));
      dropped.observe({type: 'mark'});
      dropped.disconnect();
      const taken = new PerformanceObserver(() => window.got.push(['taken']));
      taken.observe({type: 'mark'});
      performance.mark('b', {startTime: 1});
      performance.measure('b', {start: 0, end: 2});
      window.records = names(taken.takeRecords());
    JS
    expect(poll_until { session.evaluate_script('window.got.length === 2 && [window.got, window.records]') }).to eq([
      [
        ['multiple', ['b']],
        ['single', %w[b b early], %w[b b], ['b'], ['b']]
      ],
      ['b']
    ])
  end
end
