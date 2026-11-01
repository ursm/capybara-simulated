# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame realm the page is done with is disposed once no host request is under way (V8Runtime#retire_realm): a frame its
# container's `load` listener removes — inside a microtask checkpoint, where V8 refuses to dispose a context — goes all
# the same, its context collected (one context of the last may linger in V8 a while, never twenty), however the
# microtask drain before the disposal ends.
RSpec.describe 'disposing a removed frame realm' do
  html = <<~HTML
    <!DOCTYPE html><meta charset="utf-8"><body><script>
      function round(n) {
        for (let i = 0; i < n; i++) {
          const f = document.createElement('iframe');
          f.src = '/child';
          f.onload = () => f.remove();
          document.body.append(f);
        }
      }
    </script>
  HTML
  let(:app) {
    lambda {|env|
      body = env['PATH_INFO'] == '/child' ? '<!DOCTYPE html><meta charset="utf-8"><p>child' : html
      [200, {'content-type' => 'text/html'}, [body]]
    }
  }

  def native_contexts(session)
    ctx = session.driver.browser.instance_variable_get(:@runtime).instance_variable_get(:@ctx)
    ctx.low_memory_notification
    ctx.heap_statistics[:number_of_native_contexts]
  end

  def remove_frames(session)
    session.execute_script('round(20)')
    5.times { session.evaluate_script('1') }
  end

  it 'collects the context of a frame its container load listener removes' do
    session = simulated_session(app)
    session.visit '/'
    before = native_contexts(session)
    remove_frames(session)
    expect(native_contexts(session)).to be <= before + 1
  end

  # …and where the drain raises (a terminated runaway, a host function raising), the request's own result stands and the
  # realms are disposed all the same.
  it 'disposes them, the request answered, where the drain before raises' do
    session = simulated_session(app)
    session.visit '/'
    before = native_contexts(session)
    runtime = session.driver.browser.instance_variable_get(:@runtime)
    runtime.define_singleton_method(:drain_microtasks) { raise 'drain failed' }
    session.execute_script('round(20)')
    expect(session.evaluate_script('1 + 1')).to eq(2)
    runtime.singleton_class.send(:remove_method, :drain_microtasks)
    expect(native_contexts(session)).to be <= before + 1
  end
end
