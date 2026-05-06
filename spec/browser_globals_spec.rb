require 'capybara/simulated'

# Globals real apps probe at boot or use during a test. Specs here lock
# the bridge's contract for each one — apps that hit `if (typeof X)`
# guards or actually call these methods shouldn't silently misbehave.
RSpec.describe 'browser global surface' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']]
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  describe 'localStorage / sessionStorage' do
    it 'round-trips set + get within a session' do
      session.evaluate_script("localStorage.setItem('k', 'v')")
      expect(session.evaluate_script("localStorage.getItem('k')")).to eq('v')
    end

    it 'reports length and key(i)' do
      session.evaluate_script("localStorage.setItem('a', '1'); localStorage.setItem('b', '2')")
      expect(session.evaluate_script('localStorage.length')).to eq(2)
      keys = (0...2).map {|i| session.evaluate_script("localStorage.key(#{i})") }
      expect(keys).to contain_exactly('a', 'b')
    end

    it 'returns null for missing keys' do
      expect(session.evaluate_script("localStorage.getItem('missing')")).to be_nil
    end

    it 'sessionStorage is independent of localStorage' do
      session.evaluate_script("localStorage.setItem('x', 'l'); sessionStorage.setItem('x', 's')")
      expect(session.evaluate_script("localStorage.getItem('x')")).to eq('l')
      expect(session.evaluate_script("sessionStorage.getItem('x')")).to eq('s')
    end
  end

  describe 'performance' do
    it 'exposes performance.now() as a monotonic millisecond reading' do
      first  = session.evaluate_script('performance.now()')
      second = session.evaluate_script('performance.now()')
      expect(first).to be_a(Numeric)
      expect(second).to be >= first
    end

    it 'has a timeOrigin and shape-only mark / measure / getEntries' do
      expect(session.evaluate_script('typeof performance.timeOrigin')).to eq('number')
      expect(session.evaluate_script("performance.mark('x'); performance.measure('m'); performance.getEntries()")).to eq([])
    end
  end

  describe 'structuredClone' do
    it 'deep-clones plain objects and arrays' do
      cloned = session.evaluate_script(<<~JS)
        const orig = {a: 1, b: {c: 2}, d: [3, 4]};
        const copy = structuredClone(orig);
        copy.b.c = 99;
        copy.d.push(5);
        ({orig: orig, copy: copy})
      JS
      expect(cloned['orig']).to eq('a' => 1, 'b' => {'c' => 2}, 'd' => [3, 4])
      expect(cloned['copy']).to eq('a' => 1, 'b' => {'c' => 99}, 'd' => [3, 4, 5])
    end

    it 'returns primitives unchanged' do
      expect(session.evaluate_script("structuredClone(42)")).to eq(42)
      expect(session.evaluate_script("structuredClone('hi')")).to eq('hi')
      expect(session.evaluate_script("structuredClone(null)")).to be_nil
    end
  end

  describe 'requestIdleCallback / cancelIdleCallback' do
    it 'fires the callback after the timer queue drains' do
      session.evaluate_script(<<~JS)
        window.__idle = false;
        requestIdleCallback(() => { window.__idle = true });
        __drainTimers(1);
      JS
      expect(session.evaluate_script('window.__idle')).to eq(true)
    end

    it 'cancelIdleCallback cancels a pending callback' do
      session.evaluate_script(<<~JS)
        window.__idle = false;
        const id = requestIdleCallback(() => { window.__idle = true });
        cancelIdleCallback(id);
        __drainTimers(1);
      JS
      expect(session.evaluate_script('window.__idle')).to eq(false)
    end
  end

  describe 'observer stubs' do
    it 'IntersectionObserver / ResizeObserver / PerformanceObserver construct cleanly and have spec methods' do
      shape = session.evaluate_script(<<~JS)
        const probe = (Cls) => {
          const o = new Cls(() => {});
          return ['observe', 'unobserve', 'disconnect', 'takeRecords']
            .every(m => typeof o[m] === 'function');
        };
        ({
          io: probe(IntersectionObserver),
          ro: probe(ResizeObserver),
          po: probe(PerformanceObserver)
        })
      JS
      expect(shape).to eq('io' => true, 'ro' => true, 'po' => true)
    end
  end
end
