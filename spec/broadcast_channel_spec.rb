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

  # A channel goes with its realm: the page it was made in left — a visit, a session reset — reaches it with nothing a
  # later page of the same realm posts (Chrome: a page navigated away from receives nothing).
  it "reaches no channel of a page left behind" do
    session.execute_script(<<~JS)
      localStorage.clear();
      window.keep = new BroadcastChannel('x');
      keep.onmessage = (e) => localStorage.setItem('ghost', 'page one got ' + e.data);
    JS
    session.visit('/two')
    session.execute_script(<<~JS)
      window.got = [];
      new BroadcastChannel('x').onmessage = (e) => got.push(e.data);
      new BroadcastChannel('x').postMessage('hi');
    JS
    poll_until { session.evaluate_script('window.got.length') == 1 }
    session.execute_script("window.keep = new BroadcastChannel('q'); keep.onmessage = (e) => localStorage.setItem('ghost', 'reset got ' + e.data);")
    session.reset_session!
    session.visit('/three')
    session.execute_script("window.got = []; new BroadcastChannel('q').onmessage = (e) => got.push(e.data); new BroadcastChannel('q').postMessage('hey')")
    poll_until { session.evaluate_script('window.got.length') == 1 }
    expect(session.evaluate_script("localStorage.getItem('ghost')")).to be_nil
  end

  # …and a post reaches every channel but the one it was posted on, whichever realm's method posted it.
  it "delivers a frame's channel's post to the others alone, through another realm's method" do
    session.execute_script(<<~JS)
      window.got = [];
      const frame = document.createElement('iframe');
      document.body.append(frame);
      window.mine = new frame.contentWindow.BroadcastChannel('c');
      mine.onmessage = (e) => got.push('self:' + e.data);
      new BroadcastChannel('c').onmessage = (e) => got.push('other:' + e.data);
      BroadcastChannel.prototype.postMessage.call(mine, 'm');
    JS
    poll_until { session.evaluate_script('window.got.length') > 0 }
    session.evaluate_script('1')
    expect(session.evaluate_script('window.got')).to eq(['other:m'])
  end

  # A closed channel's post throws however many channels were made and closed since — the registry letting go of the
  # collected ones keeps a closed one closed.
  it "throws for a closed channel's post after many others came and went" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const c = new BroadcastChannel('n');
        c.close();
        for (let i = 0; i < 300; i++) new BroadcastChannel('m' + i).close();
        try { c.postMessage('x'); return 'none'; } catch (e) { return e.name; }
      })()
    JS
    expect(got).to eq('InvalidStateError')
  end

  # A load into the same realm — a `javascript:` URL frame's result — keeps its Window, and the channel, the port and the
  # signal its script made: they go with the context, not with the document it loads.
  it "keeps what a javascript: URL frame's script made as its result loads" do
    session.execute_script(<<~JS)
      window.got = [];
      const frame = document.createElement('iframe');
      frame.src = "javascript:window.bc = new BroadcastChannel('j'); bc.onmessage = (e) => parent.got.push('bc:' + e.data); " +
        "window.ac = new AbortController(); ac.signal.onabort = () => parent.got.push('abort'); " +
        "window.mc = new MessageChannel(); mc.port2.onmessage = (e) => parent.got.push('port:' + e.data); '<p>loaded</p>'";
      document.body.append(frame);
    JS
    poll_until { session.evaluate_script("typeof document.querySelector('iframe').contentWindow.ac") == 'object' }
    session.execute_script(<<~JS)
      const w = document.querySelector('iframe').contentWindow;
      new BroadcastChannel('j').postMessage('hi');
      w.ac.abort();
      w.mc.port1.postMessage('pm');
    JS
    poll_until { session.evaluate_script('window.got.length') >= 3 }
    expect(session.evaluate_script('window.got').sort).to eq(%w[abort bc:hi port:pm])
  end
end
