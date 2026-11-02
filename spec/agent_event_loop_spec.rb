# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML gives a similar-origin window agent ONE event loop (§8.1.7): the tasks of the page, of its frames and of theirs are
# run in the order they fall due, whichever realm queued them, and one rendering update takes every document of it, in
# tree order, each step for all of them before the next ("update the rendering"). A frame's tasks ran in a batch after
# the page's whole step instead, up to a step late, out of their order with the page's and with each other's — Chrome's
# `P0@0 F0@0 G0@0 G40@40 P45@45 …` read `P0@0 P raf 1 P45@45 P60@60 G0@67 F0@67 F raf 67 F50@67 G40@67 G55@67 G raf 67
# F70@167`.
RSpec.describe 'the event loop of a page and its frames' do
  frames = '<iframe id="f" srcdoc="<iframe id=g></iframe>"></iframe>'

  def run(page)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    expect(session).to have_title('done', wait: 10)
    session.find('#out', visible: :all).text(:all).split(' ')
  end

  # [tag, time] of each `tag@time` entry.
  def timed(log) = log.map {|entry| entry.split('@').then {|tag, at| [tag, at.to_i] } }

  # The page P, its frame F and F's frame G, each with timers set from one task of the page's, and an animation frame
  # callback each. Chrome 156 (three runs): `P0@0 F0@0 G0@0 P-raf F-raf G-raf G40@40 P45@45 F50@50 G55@55 P60@60 F70@70`;
  # Firefox 159 the same order, a timer up to 3 ms late.
  it "runs the tasks of every frame in the order they fall due, and the frames' animation callbacks in one update" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>forder</title>#{frames}<pre id="out"></pre>
      <script>
        const log = [];
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          const gw = fw.document.getElementById('g').contentWindow;
          const at = () => Math.round(performance.now() - window.base);
          const T = (w, ms, tag) => w.setTimeout(() => log.push(tag + '@' + at()), ms);
          const R = (w, tag) => w.requestAnimationFrame(() => log.push(tag + '-raf'));
          setTimeout(() => {
            window.base = performance.now();
            T(window, 60, 'P60'); T(fw, 50, 'F50'); T(gw, 40, 'G40'); T(fw, 70, 'F70');
            T(window, 45, 'P45'); T(gw, 55, 'G55');
            T(window, 0, 'P0'); T(fw, 0, 'F0'); T(gw, 0, 'G0');
            R(window, 'P'); R(fw, 'F'); R(gw, 'G');
            setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 300);
          }, 33);
        };
      </script>
    HTML
    expect(log.map {|e| e.split('@').first }).to eq(%w[P0 F0 G0 P-raf F-raf G-raf G40 P45 F50 G55 P60 F70])
    timed(log.reject {|e| e.end_with?('-raf') }).each do |tag, at|
      due = tag[1..].to_i
      expect(at).to be_between(due, due + 2), "#{tag} ran at #{at}"
    end
  end

  # One rendering update runs each document's animation frame callbacks in tree order, whatever order they were
  # requested in, taking a document's as its turn comes: one the page's callback requests of the frame runs in this
  # update, one the nested frame's requests of the page in the next — and a task queued by a callback after all of them.
  # Chrome 156 and Firefox 159 (three runs each): `P1 F1 F2 G1 T P2`.
  it "runs the documents' animation frame callbacks in tree order, each document's taken as its turn comes" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>rforder</title>#{frames}<pre id="out"></pre>
      <script>
        const log = [];
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          const gw = fw.document.getElementById('g').contentWindow;
          setTimeout(() => {
            gw.requestAnimationFrame(() => {
              log.push('G1');
              requestAnimationFrame(() => log.push('P2'));
            });
            fw.requestAnimationFrame(() => log.push('F1'));
            requestAnimationFrame(() => {
              log.push('P1');
              fw.requestAnimationFrame(() => log.push('F2'));
              setTimeout(() => log.push('T'), 0);
            });
            setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 300);
          }, 33);
        };
      </script>
    HTML
    expect(log).to eq(%w[P1 F1 F2 G1 T P2])
  end

  # A worker's message is a task of the event loop of the window it is posted to, queued at the time it was sent: it runs
  # after every task of that event loop due before it — a frame's, where the page receives it, the page's, where the frame
  # does. Chrome 156 (three runs): `F40@40 W45@45 P50@50 | P40@40 WF45@45 P50@50 F52@52`; Firefox 159 the same order,
  # each within a ms of it.
  it "runs a worker's message after the tasks of every frame due before it" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>xorder</title>#{frames}<pre id="out"></pre>
      <script>
        const log = [];
        const src = URL.createObjectURL(new Blob(["onmessage = (e) => setTimeout(() => postMessage(e.data), e.data[1]);"], {type: 'text/javascript'}));
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          const at = () => Math.round(performance.now() - window.base);
          const w = new Worker(src), wf = new fw.Worker(src);
          w.onmessage = wf.onmessage = (e) => { if (window.base) log.push(e.data[0] + '@' + at()); };
          w.postMessage(['warm', 0]); wf.postMessage(['warm', 0]);
          setTimeout(() => {
            window.base = performance.now();
            w.postMessage(['W45', 45]);
            fw.setTimeout(() => log.push('F40@' + at()), 40);
            setTimeout(() => log.push('P50@' + at()), 50);
            setTimeout(() => {
              log.push('|');
              window.base = performance.now();
              wf.postMessage(['WF45', 45]);
              setTimeout(() => log.push('P40@' + at()), 40);
              setTimeout(() => log.push('P50@' + at()), 50);
              fw.setTimeout(() => log.push('F52@' + at()), 52);
              setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 300);
            }, 200);
          }, 300);
        };
      </script>
    HTML
    expect(log.map {|e| e.split('@').first }).to eq(%w[F40 W45 P50 | P40 WF45 P50 F52])
    timed(log - ['|']).each do |tag, at|
      due = tag[/\d+/].to_i
      expect(at).to be_between(due, due + 2), "#{tag} ran at #{at}"
    end
  end

  # Two realms each waiting on a worker's message sent 60 ms on — each worker spinning that long first — wait behind the
  # frame's 30 ms timer, not behind each other's turn of waiting: each took the other's for a task due now and queued its
  # own again at once, some 75,000 times, until the messages' time came by the machine's own clock, the frame's timer
  # 40 ms late. Chrome 156 (two runs): `P20@20 F30@30 WF60@60 W60@60 P90@90`; Firefox 159 the two messages the other
  # way about, within a ms.
  it "runs two realms' waiting worker messages after the timers due before them" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>xpp</title>#{frames}<pre id="out"></pre>
      <script>
        const log = [];
        const src = URL.createObjectURL(new Blob(["onmessage = (e) => { const s = Date.now(); while (Date.now() - s < e.data[1]) {} postMessage(e.data); };"], {type: 'text/javascript'}));
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          const at = () => Math.round(performance.now() - window.base);
          const w = new Worker(src), wf = new fw.Worker(src);
          w.onmessage = wf.onmessage = (e) => { if (window.base) log.push(e.data[0] + '@' + at()); };
          w.postMessage(['warm', 0]); wf.postMessage(['warm', 0]);
          setTimeout(() => {
            window.base = performance.now();
            w.postMessage(['W60', 60]);
            wf.postMessage(['WF60', 60]);
            setTimeout(() => log.push('P20@' + at()), 20);
            fw.setTimeout(() => log.push('F30@' + at()), 30);
            setTimeout(() => log.push('P90@' + at()), 90);
            setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 300);
          }, 300);
        };
      </script>
    HTML
    tags = log.map {|e| e.split('@').first }
    expect([tags[0, 2], tags[2, 2].sort, tags[4..]]).to eq([%w[P20 F30], %w[W60 WF60], %w[P90]])
    timed(log).each do |tag, at|
      due = tag[/\d+/].to_i
      expect(at).to be_between(due, due + 10), "#{tag} ran at #{at}"
    end
  end

  # A frame's document timeline and its animation frame callbacks' time count from ITS time origin, as its
  # `performance.now()` does, whatever the event loop's clock read as it was made. Chrome 156 (two runs): `102 90 90`;
  # Firefox 159 `101 101 101`.
  it "reads a frame's timeline and animation frame time from the frame's time origin" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>tl</title><pre id="out"></pre>
      <script>
        setTimeout(() => {
          const f = document.createElement('iframe');
          document.body.appendChild(f);
          const fw = f.contentWindow;
          setTimeout(() => {
            fw.requestAnimationFrame((ts) => {
              const at = (t) => Math.round(t);
              document.getElementById('out').textContent = [fw.performance.now(), fw.document.timeline.currentTime, ts].map(at).join(' ');
              document.title = 'done';
            });
          }, 100);
        }, 2000);
      </script>
    HTML
    now, timeline, stamp = log.map(&:to_i)
    expect(now).to be_between(100, 120)
    expect([timeline, stamp]).to all(be_between(now - 17, now))
  end

  # A frame the page's task removes runs none of its timers after — not to the end of the step the removal fell in.
  # Chrome 156 and Firefox 159: `removed`.
  it "runs no timer of a frame the page removed" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>detach</title>#{frames}<pre id="out"></pre>
      <script>
        const log = window.log = [];
        onload = () => {
          const f = document.getElementById('f');
          f.contentWindow.eval("const L = parent.log; setTimeout(() => L.push('F100'), 100); setInterval(() => L.push('Fi'), 30);");
          setTimeout(() => { f.remove(); log.push('removed'); }, 10);
          setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 400);
        };
      </script>
    HTML
    expect(log).to eq(%w[removed])
  end
end
