# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# The performance timeline — Performance, PerformanceEntry, PerformanceMark / Measure, PerformanceResourceTiming,
# PerformanceServerTiming — generated from their IDL: arguments required and converted, brands checked, state in
# slots, mark() and measure() the User Timing steps. The figures are headless Chrome's, but where the spec decides: an
# entry has its `id` (Chrome: none), and measure()'s `duration` is a timestamp a negative one of which is a TypeError
# ("convert a mark to a timestamp"; Chrome takes it).
RSpec.describe 'Performance bindings' do
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

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          error(() => new PerformanceEntry()),
          error(() => new PerformanceMeasure()),
          error(() => new PerformanceServerTiming()),
          error(() => new Performance()),
          error(() => performance.mark()),
          error(() => performance.measure()),
          error(() => Performance.prototype.now.call({})),
          Object.getOwnPropertyNames(PerformanceEntry.prototype).sort(),
          Object.keys(performance.toJSON())
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'PerformanceEntry': Illegal constructor",
      "TypeError: Failed to construct 'PerformanceMeasure': Illegal constructor",
      "TypeError: Failed to construct 'PerformanceServerTiming': Illegal constructor",
      "TypeError: Failed to construct 'Performance': Illegal constructor",
      "TypeError: Failed to execute 'mark' on 'Performance': 1 argument required, but only 0 present.",
      "TypeError: Failed to execute 'measure' on 'Performance': 1 argument required, but only 0 present.",
      'TypeError: Illegal invocation',
      %w[constructor duration entryType id name navigationId startTime toJSON],
      ['timeOrigin']
    ])
  end

  # A mark: no PerformanceTiming name, no negative start time, its detail cloned (null for none — the value a clone
  # refuses named as structuredClone names it, where Chrome quotes a function's source), its JSON its entry's attributes;
  # one made by `new` is in no buffer.
  it 'makes a mark as User Timing says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const detail = {k: 1};
        const m = performance.mark('a', {detail});
        const made = new PerformanceMark('n', {startTime: 5});
        return [
          error(() => performance.mark('neg', {startTime: -1})),
          error(() => performance.mark('navigationStart')),
          error(() => new PerformanceMark('loadEventEnd')),
          error(() => performance.mark('d', {detail: () => 1})),
          [m.detail === detail, m.detail === m.detail, m.detail.k, performance.mark('u').detail, performance.mark('v', {detail: null}).detail],
          [made.startTime, made.entryType, made.detail, performance.getEntriesByName('n').length],
          Object.keys(m.toJSON()),
          typeof m.id === 'number' && performance.mark('next').id > m.id
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to execute 'mark' on 'Performance': 'neg' cannot have a negative start time.",
      "SyntaxError: Failed to execute 'mark' on 'Performance': 'navigationStart' is part of the PerformanceTiming interface, and cannot be used as a mark name.",
      "SyntaxError: Failed to construct 'PerformanceMark': 'loadEventEnd' is part of the PerformanceTiming interface, and cannot be used as a mark name.",
      "DataCloneError: Failed to execute 'mark' on 'Performance': A function could not be cloned.",
      [false, true, 1, nil, nil],
      [5, 'mark', nil, 0],
      %w[id name entryType startTime duration navigationId],
      true
    ])
  end

  # measure(): its options' checks, its end and start times from marks, timestamps, a duration or now, navigationStart
  # 0 and every other PerformanceTiming name an event that has not happened.
  it 'measures as User Timing says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        performance.mark('a', {startTime: 10});
        performance.mark('b', {startTime: 15});
        const span = (m) => [m.startTime, m.duration, m.detail];
        return [
          error(() => performance.measure('m', 'nope')),
          error(() => performance.measure('m', {detail: 1})),
          error(() => performance.measure('m', {start: 1, duration: 2, end: 3})),
          error(() => performance.measure('m', {start: 1}, 'a')),
          error(() => performance.measure('m', {start: -1, end: 2})),
          error(() => performance.measure('m', {start: 1, duration: -1})),
          error(() => performance.measure('m', 'domComplete')),
          span(performance.measure('m1', 'a', 'b')),
          span(performance.measure('m2', {start: 1, end: 3, detail: 'd'})),
          span(performance.measure('m3', {duration: 2, end: 10})),
          span(performance.measure('m4', {start: 'a', duration: 3})),
          span(performance.measure('m5', 'navigationStart', 'a'))
        ];
      })()
    JS
    expect(got).to eq([
      "SyntaxError: Failed to execute 'measure' on 'Performance': The mark 'nope' does not exist.",
      "TypeError: Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, at least one of its 'start' or 'end' properties must be present.",
      "TypeError: Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, it must not have all of its 'start', 'duration', and 'end' properties defined",
      "TypeError: Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, |end_mark| must not be passed.",
      "TypeError: Failed to execute 'measure' on 'Performance': 'm' cannot have a negative time stamp.",
      "TypeError: Failed to execute 'measure' on 'Performance': 'm' cannot have a negative time stamp.",
      "InvalidAccessError: Failed to execute 'measure' on 'Performance': 'domComplete' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.",
      [10, 5, nil],
      [1, 2, 'd'],
      [8, 2, nil],
      [10, 3, nil],
      [0, 10, nil]
    ])
  end

  # A resource entry's JSON: its entry's attributes first (the inherited [Default] toJSON), then its own.
  it 'serializes a resource entry with what it inherits' do
    session.execute_script("fetch('/x')")
    keys = poll_until { session.evaluate_script("(performance.getEntriesByType('resource')[0] || null) && Object.keys(performance.getEntriesByType('resource')[0].toJSON())") }
    expect(keys.first(6)).to eq(%w[id name entryType startTime duration navigationId])
    expect(keys).to include('serverTiming', 'workerStart', 'responseStatus')
  end

  # A Performance method answers with the timeline of the object it is called on — a frame's from this realm too — and
  # takes no object that is no Performance (Chrome: the frame's marks; Illegal invocation); a measure is the frame's
  # realm's ("this's relevant realm"), a mark this one's (the constructor's "current global object", where Chrome makes
  # the frame's).
  it 'answers with the timeline it is called on' do
    session.execute_script(<<~JS)
      const frame = document.body.appendChild(document.createElement('iframe'));
      window.fp = frame.contentWindow.performance;
      fp.mark('fa');
      performance.mark('top');
    JS
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          Performance.prototype.getEntriesByType.call(fp, 'mark').map((e) => e.name),
          typeof Performance.prototype.now.call(fp),
          error(() => Performance.prototype.now.call(Object.create(Performance.prototype))),
          Performance.prototype.measure.call(fp, 'fm') instanceof fp.constructor.prototype.measure.call(fp, 'fm2').constructor,
          Performance.prototype.measure.call(fp, 'fm3') instanceof PerformanceMeasure,
          Performance.prototype.mark.call(fp, 'fk') instanceof PerformanceMark
        ];
      })()
    JS
    expect(got).to eq([['fa'], 'number', 'TypeError: Illegal invocation', true, false, true])
  end

  # An entry's id and navigation id are given it when it is queued: the navigation's first, so the smaller; a mark made
  # with `new` is never queued and has neither.
  it 'gives an entry its ids when it is queued' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const a = performance.mark('a'), b = performance.mark('b'), made = new PerformanceMark('made');
        return [a.navigationId > 0, a.navigationId < a.id, b.id > a.id, b.navigationId === a.navigationId, made.id, made.navigationId];
      })()
    JS
    expect(got).to eq([true, true, true, true, 0, 0])
  end
end
