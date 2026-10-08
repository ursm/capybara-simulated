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

  # Chrome's order (measured): each message to every channel in creation order — a frame's channel made first, then the
  # window's two — before the next message.
  it "delivers another isolate's posts to this one's channels in creation order, each its own data" do
    session.execute_script(<<~JS)
      window.got = [];
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const fc = new frame.contentWindow.BroadcastChannel('o');
      fc.onmessage = (e) => window.got.push('frame:' + e.data.v);
      const c1 = new BroadcastChannel('o'), c2 = new BroadcastChannel('o');
      c1.onmessage = (e) => { window.got.push('main:' + e.data.v); e.data.v = 'changed'; };
      c2.onmessage = (e) => window.got.push('main2:' + e.data.v);
      new Worker(URL.createObjectURL(new Blob(["const c = new BroadcastChannel('o'); c.postMessage({v: 'a'}); c.postMessage({v: 'b'});"], {type: 'text/javascript'})));
    JS
    poll_until { session.evaluate_script('window.got.length === 6') }
    expect(session.evaluate_script('window.got')).to eq(%w[frame:a main:a main2:a frame:b main:b main2:b])
  end

  it "settles only once a worker's channel has answered a post" do
    session.execute_script(<<~JS)
      window.reply = null;
      const w = new Worker(URL.createObjectURL(new Blob(["const c = new BroadcastChannel('r'); c.onmessage = (e) => postMessage('re:' + e.data); postMessage('ready');"], {type: 'text/javascript'})));
      w.onmessage = (e) => { window.reply = e.data; };
    JS
    poll_until { session.evaluate_script('window.reply') == 'ready' }
    session.execute_script(<<~JS)
      const button = document.createElement('button');
      button.textContent = 'ping';
      button.onclick = () => new BroadcastChannel('r').postMessage('x');
      document.body.append(button);
    JS
    session.click_button('ping')
    expect(session.evaluate_script('window.reply')).to eq('re:x')
  end
end
