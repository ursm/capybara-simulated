# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# IntersectionObserver and PerformanceObserver, with their entries and entry lists, generated from their IDL: arguments
# required and converted, brands checked, state in slots. The figures are headless Chrome's, but for two the spec
# decides: IntersectionObserverEntry has a constructor (the IDL's; Chrome's is illegal), and trackVisibility clamps a
# delay below 100 to 100 (the spec's "set delay to 100"; Chrome throws NotSupportedError).
RSpec.describe 'Observer bindings' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
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
end
