require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# WebAssembly's asynchronous API settles as any promise does: V8 compiles on the calling thread
# (`--no-wasm-async-compilation`, v8_runtime.rb), since its asynchronous compilation finishes on platform tasks of
# its own that this driver's event loop never runs as tasks — a page awaiting its module waited for good.
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
end
