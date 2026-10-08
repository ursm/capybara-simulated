# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A message posted on a BroadcastChannel reaches each channel as a task of its own (HTML "queue a global task on the DOM
# manipulation task source"): its microtasks run before the next message arrives — a promise reaction that re-arms
# between two posts sees the second, whether they come from this window or from a worker.
RSpec.describe 'BroadcastChannel delivery' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']] })
    s.visit('/')
    s
  }

  it "delivers a worker's posts one task each" do
    session.execute_script(<<~JS)
      let armed = true;
      const got = [];
      const channel = new BroadcastChannel('t');
      channel.onmessage = (e) => {
        got.push(e.data + ':' + armed);
        armed = false;
        Promise.resolve().then(() => { armed = true; });
        if (got.length === 2) window.got = got;
      };
      new Worker(URL.createObjectURL(new Blob(["const c = new BroadcastChannel('t'); c.postMessage('a'); c.postMessage('b');"], {type: 'text/javascript'})));
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq(%w[a:true b:true])
  end
end
