require 'capybara/simulated'
require_relative 'support/session_teardown'

# AbortSignal as DOM §3.2 makes it: its state no enumeration sees, its abort's algorithms — a `{signal}` listener's
# removal — run before its `abort` event, which a listener could stop or redispatch; `AbortSignal.timeout`'s delay an
# unsigned long long, no timer's `long`; a RequestInit's `signal` an AbortSignal to fetch() as to the constructor; no
# signal cloned; and the handlers of an interface not yet generated asked of its objects alone.
RSpec.describe 'AbortSignal' do
  let(:app) { ->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x<iframe srcdoc="y"></iframe>']] } }
  let(:session) { simulated_session(app) }

  it 'is the signal DOM makes' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], c = new AbortController();
      new Request('/x', { signal: c.signal });
      const keys = [Object.keys(c), Object.keys(c.signal), JSON.stringify({ signal: c.signal })];
      // (…a listener before the `{signal}` one stopping the event: the removal ran before it, all the same)
      const t = new EventTarget(), fired = [];
      c.signal.addEventListener('abort', (e) => e.stopImmediatePropagation());
      t.addEventListener('zq', () => fired.push('zq'), { signal: c.signal });
      c.signal.addEventListener('abort', () => t.dispatchEvent(new Event('zq')));
      c.abort();
      t.dispatchEvent(new Event('zq'));
      const big = AbortSignal.timeout(2 ** 31), huge = AbortSignal.timeout(2 ** 32 + 5);
      const errs = [() => structuredClone(c.signal), () => structuredClone(c), () => Object.getPrototypeOf(matchMedia('all')).onchange]
        .map((f) => { try { f(); return 'ok'; } catch (e) { return e.name; } });
      fetch('/x', { signal: { aborted: true, reason: 'dt' } }).then(() => 'resolved', (e) => e.name).then((f) => {
        setTimeout(() => done([keys, fired, big.aborted, huge.aborted, errs, f]), 20);
      });
    JS
    expect(got).to eq([
      [[], [], '{"signal":{}}'],
      [],
      false, false,
      ['DataCloneError', 'DataCloneError', 'TypeError'],
      'TypeError'
    ])
  end

  it "keeps a dependent signal with a listener, which nothing else holds, till it aborts" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], c = new AbortController(), t = new EventTarget();
      let fired = 0, heard = 0;
      (() => { AbortSignal.any([c.signal]).addEventListener('abort', () => fired++); })();
      (() => { t.addEventListener('q', () => heard++, { signal: AbortSignal.any([c.signal]) }); })();
      // (…a composite with neither, collected — the proof a collection ran: not asked till the end, as a deref keeps its
      // target for the rest of the job)
      const plain = new WeakRef(AbortSignal.any([c.signal]));
      (async () => {
        for (let i = 0; i < 10; i++) {
          let junk = [];
          for (let j = 0; j < 500000; j++) junk.push({ j });
          junk = null;
          await new Promise((r) => setTimeout(r, 0));
        }
        const collected = !plain.deref();
        c.abort();
        t.dispatchEvent(new Event('q'));
        done([collected, fired, heard]);
      })();
    JS
    expect(got).to eq([true, 1, 0])
  end

  it "asks another realm's object for a handler as its own realm's" do
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq([true, nil])
      (() => {
        const x = new frames[0].XMLHttpRequest(), f = () => {};
        Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'onload').set.call(x, f);
        return [x.onload === f, Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage').get.call(new frames[0].BroadcastChannel('q'))];
      })()
    JS
  end
end
