# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A realm's timeline — its buffers and registered observers, the engine's (perf_timeline.rs) — as long as what holds
# its `performance` holds it. Chrome's figures.
RSpec.describe 'the performance timeline buffers' do
  include PollUntil

  def session(routes = {})
    routes = {'/' => '<!DOCTYPE html><meta charset="utf-8"><body>'}.merge(routes)
    s = simulated_session(->(env) {
      path = env['PATH_INFO']
      next [404, {}, ['']] unless routes.key?(path)

      [200, {'content-type' => path.end_with?('.js') ? 'text/javascript' : 'text/html'}, [routes[path]]]
    })
    s.visit '/'
    s
  end

  # A removed frame's `performance` still records, finds its marks and queues them on its observers (Chrome: the mark
  # and the measure on each side of the removal, 4, beside the navigation and visibility-state entries not modelled).
  it "keeps a removed frame's timeline working" do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq([4, 2])
      (() => {
        const f = document.createElement('iframe');
        document.body.append(f);
        const fp = f.contentWindow.performance;
        const po = new f.contentWindow.PerformanceObserver(() => {});
        po.observe({type: 'mark'});
        fp.mark('before');
        f.remove();
        fp.mark('after');
        fp.measure('m', 'before');
        fp.measure('n', 'after');
        return [fp.getEntriesByType('mark').length + fp.getEntriesByType('measure').length, po.takeRecords().length];
      })()
    JS
  end

  # An entry type is one of the supported ones by name, not by what Object.prototype holds.
  it 'observes no type an inherited property names' do
    s = session
    s.execute_script(<<~JS)
      window.R = [];
      Object.prototype.foo = 1;
      new PerformanceObserver(() => R.push('called')).observe({type: 'foo'});
      delete Object.prototype.foo;
      performance.mark('m');
      setTimeout(() => R.push('done'), 0);
    JS
    expect(poll_until { s.evaluate_script('R.includes("done") && R') }).to eq(['done'])
  end

  # The first callback since an observe() reports the entries dropped from the full buffers of its types (Chrome: a
  # buffer of 1 and four scripts, `{droppedEntriesCount: 3}`).
  it 'reports the resources a full buffer dropped' do
    scripts = (1..4).to_h {|i| ["/s#{i}.js", '1;'] }
    s = session(scripts)
    s.execute_script(<<~JS)
      window.R = [];
      performance.setResourceTimingBufferSize(1);
      let loaded = 0;
      for (let i = 1; i <= 4; i++) {
        const script = document.createElement('script');
        script.src = '/s' + i + '.js';
        script.onload = () => { if (++loaded === 4) setTimeout(observe, 10); };
        document.body.append(script);
      }
      function observe() {
        new PerformanceObserver((list, observer, options) => R.push(list.getEntries().length, options.droppedEntriesCount))
          .observe({type: 'resource', buffered: true});
      }
    JS
    expect(poll_until { s.evaluate_script('R.length && R') }).to eq([1, 3])
  end
end
