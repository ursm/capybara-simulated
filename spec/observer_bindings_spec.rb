# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# IntersectionObserver, ResizeObserver and PerformanceObserver, with their entries, sizes and entry lists, generated from
# their IDL: arguments required and converted, brands checked, state in slots. The figures are headless Chrome's, but for two the spec
# decides: IntersectionObserverEntry has a constructor (the IDL's; Chrome's is illegal), and trackVisibility clamps a
# delay below 100 to 100 (the spec's "set delay to 100"; Chrome throws NotSupportedError).
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
end
