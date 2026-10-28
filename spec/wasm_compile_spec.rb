require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# WebAssembly's asynchronous API settles in a queued task (the WebAssembly JS API's "asynchronously compile"): V8
# compiles on the calling thread (`--no-wasm-async-compilation`, v8_runtime.rb) — its asynchronous compilation
# finishes on platform tasks of its own that this driver's event loop never runs, so a page awaiting its module waited
# for good — and hands the promise's resolution to wasm.rs, which queues it as a task.
RSpec.describe 'WebAssembly compilation' do
  it 'settles compile and instantiate' do
    s = simulated_session(->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><p>x']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = [];
      const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
      WebAssembly.compile(bytes)
        .then((m) => { got.push('compile ' + (m instanceof WebAssembly.Module)); return WebAssembly.compile(bytes); })
        .then(() => got.push('again'))
        .then(() => WebAssembly.instantiate(bytes))
        .then(({ instance }) => got.push('instantiate ' + (instance instanceof WebAssembly.Instance)), (e) => got.push('error ' + e));
    JS
    poll_until { s.evaluate_script('got.length') == 3 }

    expect(s.evaluate_script('got')).to eq(['compile true', 'again', 'instantiate true'])
  end

  # (…after the task that asked: its microtasks first — Chrome: micro, then the compile)
  it 'settles a compile after the microtasks of the task that started it' do
    s = simulated_session(->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><p>x']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.order = [];
      const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
      WebAssembly.compile(bytes).then(() => order.push('compile'));
      WebAssembly.instantiate(bytes).then(() => order.push('instantiate'));
      Promise.resolve().then(() => order.push('micro'));
    JS
    poll_until { s.evaluate_script('order.length') == 3 }

    expect(s.evaluate_script('order')).to eq(%w[micro compile instantiate])
  end
end
