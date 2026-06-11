require 'capybara/simulated'

# A rejection with NO handler ever attached (fire-and-forget async function,
# bare `Promise.reject`) never flows through the bridge's `Promise.prototype
# .then` wrap — it is only observable via the engine's native promise-reject
# channel. These lock that channel's contract: the `unhandledrejection`
# event fires on window, and a handler attached before the microtask
# checkpoint suppresses it.
RSpec.describe 'unhandled promise rejections' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']]
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  it 'fires unhandledrejection for a fire-and-forget async throw' do
    # The window event rides V8's promise-reject channel
    # (`RustyRacer.setPromiseRejectHandler`); under QuickJS the equivalent
    # surfaces as a Ruby-side console log (vm.on_unhandled_rejection), not
    # a JS event.
    env = ENV['CSIM_JS_ENGINE'].to_s
    v8  = env.empty? ? Gem.loaded_specs.key?('rusty_racer') : env == 'v8'
    skip 'native promise-reject channel needs the V8 engine' unless v8
    session.execute_script(<<~JS)
      window.__seen = null;
      window.addEventListener('unhandledrejection', e => {
        window.__seen = String(e.reason && e.reason.message);
      });
      (async () => { throw new Error('fire-and-forget'); })();
    JS
    expect(session.evaluate_script('window.__seen')).to eq('fire-and-forget')
  end

  it 'does not fire when a handler is attached before the checkpoint' do
    session.execute_script(<<~JS)
      window.__seen = null;
      window.addEventListener('unhandledrejection', () => { window.__seen = 'fired'; });
      const p = Promise.reject(new Error('handled-later'));
      p.catch(() => {});
    JS
    expect(session.evaluate_script('window.__seen')).to be_nil
  end
end
