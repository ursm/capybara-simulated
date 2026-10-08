require 'capybara/simulated'
require_relative 'support/session_teardown'

# A rejection with NO handler ever attached (fire-and-forget async function,
# bare `Promise.reject`) is observable only via the engine's native
# promise-reject channel. These lock that channel's contract: the
# `unhandledrejection` event fires on window, and a handler attached before
# HTML's notify task runs suppresses it.
RSpec.describe 'unhandled promise rejections' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']]
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  it 'fires unhandledrejection for a fire-and-forget async throw' do
    # The window event rides V8's promise-reject channel
    # (`RustyRacer.setPromiseRejectHandler`).
    session.execute_script(<<~JS)
      window.__seen = null;
      window.addEventListener('unhandledrejection', e => {
        window.__seen = String(e.reason && e.reason.message);
      });
      (async () => { throw new Error('fire-and-forget'); })();
    JS
    expect(session.evaluate_script('window.__seen')).to eq('fire-and-forget')
  end

  it 'does not fire when a handler is attached in the same task' do
    session.execute_script(<<~JS)
      window.__seen = null;
      window.addEventListener('unhandledrejection', () => { window.__seen = 'fired'; });
      const p = Promise.reject(new Error('handled-later'));
      p.catch(() => {});
    JS
    expect(session.evaluate_script('window.__seen')).to be_nil
  end

  # (…a chain whose derived promise is handled — `p.then(f).catch(h)`, testharness's `promise_rejects_js` — is no
  # unhandled rejection, and `then` is the engine's own)
  it 'does not fire for a rejection a later link of its chain handles' do
    session.execute_script(<<~JS)
      window.__seen = [];
      window.addEventListener('unhandledrejection', (e) => { window.__seen.push(String(e.reason)); });
      Promise.reject(new Error('caught downstream')).then(() => {}).catch(() => {});
      Promise.resolve().then(() => { throw new Error('thrown in then'); }).then(() => {}).catch(() => {});
    JS
    expect(session.evaluate_script('[window.__seen, Promise.prototype.then.toString().includes("[native code]")]')).to eq([[], true])
  end

  # HTML's "notify about rejected promises" runs as a task, skipping a promise handled by then: one an `await` chain
  # reaches a few microtasks later is no unhandled rejection (Chrome: none), where one no handler ever reaches is.
  it 'does not fire for a rejection handled a few microtasks later, in the same task' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], seen = [];
      addEventListener('unhandledrejection', (e) => seen.push(e.reason.message));
      const late = Promise.reject(new Error('late'));
      (async () => { await null; await null; await null; late.catch(() => {}); })();
      Promise.reject(new Error('never'));
      setTimeout(() => setTimeout(() => done(seen), 0), 0);
    JS
    expect(got).to eq(['never'])
  end

  # The notify task comes after the tasks the rejecting task queued: a handler a `setTimeout(0)` or a `postMessage` it
  # queued attaches is in time (Chrome: no event), one a task queued later attaches is not — `unhandledrejection` and
  # then `rejectionhandled` (Chrome: the same).
  it 'does not fire for a rejection handled in a task the rejecting task queued' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], seen = [];
      addEventListener('unhandledrejection', (e) => seen.push('unhandled:' + e.reason));
      addEventListener('rejectionhandled', (e) => seen.push('handled:' + e.reason));
      const b = Promise.reject('B');
      setTimeout(() => b.catch(() => {}), 0);
      const d = Promise.reject('D'), channel = new MessageChannel();
      channel.port1.onmessage = () => d.catch(() => {});
      channel.port2.postMessage(0);
      const late = Promise.reject('late');
      setTimeout(() => setTimeout(() => late.catch(() => {}), 0), 0);
      setTimeout(() => setTimeout(() => setTimeout(() => setTimeout(() => done(seen), 0), 0), 0), 0);
    JS
    expect(got).to eq(%w[unhandled:late handled:late])
  end

  # A rejection in a frame removed before the notify task is reported nowhere — not on the parent's window (Chrome: no
  # event).
  it "does not report a removed frame's rejection on the parent" do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], seen = [];
      addEventListener('unhandledrejection', (e) => seen.push(e.reason));
      const frame = document.createElement('iframe');
      document.body.append(frame);
      frame.contentWindow.Promise.reject('frame');
      frame.remove();
      setTimeout(() => setTimeout(() => done(seen), 0), 0);
    JS
    expect(got).to eq([])
  end
end
