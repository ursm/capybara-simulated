# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
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
          const at = () => Math.round(document.timeline.currentTime - window.base);
          const T = (w, ms, tag) => w.setTimeout(() => log.push(tag + '@' + at()), ms);
          const R = (w, tag) => w.requestAnimationFrame(() => log.push(tag + '-raf'));
          setTimeout(() => {
            window.base = document.timeline.currentTime;
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
    # (…each at its time on the timeline, the virtual clock's, which no script's real time moves)
    timed(log.reject {|e| e.end_with?('-raf') }).each do |tag, at|
      due = tag[1..].to_i
      expect(at).to be_between(due, due + 1), "#{tag} ran at #{at}"
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
          const at = () => Math.round(document.timeline.currentTime - window.base);
          const w = new Worker(src), wf = new fw.Worker(src);
          w.onmessage = wf.onmessage = (e) => { if (window.base) log.push(e.data[0] + '@' + at()); };
          w.postMessage(['warm', 0]); wf.postMessage(['warm', 0]);
          setTimeout(() => {
            window.base = document.timeline.currentTime;
            w.postMessage(['W45', 45]);
            fw.setTimeout(() => log.push('F40@' + at()), 40);
            setTimeout(() => log.push('P50@' + at()), 50);
            setTimeout(() => {
              log.push('|');
              window.base = document.timeline.currentTime;
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
    # (…a worker's message at the time its sender's `Date` read as it posted, its scripts' real time among it — which the
    # page's clock is held at from then: what runs at or after it a few ms more on a loaded machine, 48 for 45 and 54 for
    # 50 in a full suite's run; what runs before it to the ms, on the timeline, the virtual clock's)
    lifted = false
    log.each do |entry|
      next lifted = false if entry == '|'

      tag, at = entry.split('@')
      lifted ||= tag.start_with?('W')
      due = tag[/\d+/].to_i
      expect(at.to_i).to be_between(due, due + (lifted ? 10 : 1)), "#{tag} ran at #{at}"
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
    # (…a worker's 60 ms spun on its own `Date`, rounded apart from this page's: 59 at the least, as in Firefox)
    timed(log).each do |tag, at|
      due = tag[/\d+/].to_i
      expect(at).to be_between(due - (tag.start_with?('W') ? 1 : 0), due + 10), "#{tag} ran at #{at}"
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
    # (…`now` counting the scripts' real time as well as the virtual clock the other two read)
    expect([timeline, stamp]).to all(be_between(83, now))
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

  # …nor one whose own task removed it: what the platform queued for it then still runs (a request it sent failing,
  # WPT xhr/open-url-multi-window-4), its own timers not. Chrome 156 and Firefox 159: `selfremoved`.
  it "runs no timer of a frame that removed itself" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>selfrm</title>#{frames}<pre id="out"></pre>
      <script>
        const log = window.log = [];
        onload = () => {
          document.getElementById('f').contentWindow.eval("const L = parent.log; setInterval(() => L.push('Fi'), 30); setTimeout(() => { frameElement.remove(); L.push('selfremoved'); }, 10);");
          setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 400);
        };
      </script>
    HTML
    expect(log).to eq(%w[selfremoved])
  end

  # …nor a message it posted itself before it went, nor a port's: its document is no longer fully active. Its microtasks
  # still run, at the checkpoint of the task that removed it. Chrome 156 and Firefox 159: `F-rm F-micro P20`.
  it "delivers no message a frame posted itself before removing itself" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>selfpm</title>#{frames}<pre id="out"></pre>
      <script>
        const log = [];
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          fw.eval("window.go = (log) => setTimeout(() => { onmessage = () => log.push('F-msg'); postMessage('x', '*'); const c = new MessageChannel(); c.port1.onmessage = () => log.push('F-mc'); c.port2.postMessage(1); Promise.resolve().then(() => log.push('F-micro')); log.push('F-rm'); frameElement.remove(); }, 10);");
          setTimeout(() => {
            fw.go(log);
            setTimeout(() => log.push('P20'), 20);
            setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 200);
          }, 50);
        };
      </script>
    HTML
    expect(log).to eq(%w[F-rm F-micro P20])
  end

  # A timer's nesting level is the event loop's running task's (HTML timer initialization steps, step 5: "the surrounding
  # agent's event loop's currently running task"), whichever realm's `setTimeout` is called: a 0 ms timer set in a frame
  # from the page's timer nested eight deep is clamped to 4 ms, as the page's own is. Firefox 159 (two runs): `F +4 P +4`
  # and `F +5 P +5`; Chrome 156 keeps a level per realm, `F +0 P +4` — the spec wins.
  it "clamps a frame's timer set from a deeply nested timer of the page's" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>nest</title>#{frames}<pre id="out"></pre>
      <script>
        const log = [];
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          fw.eval("window.T0 = (cb) => setTimeout(cb, 0);");
          setTimeout(() => {
            let depth = 0;
            function step() {
              depth++;
              if (depth === 8) {
                const a = document.timeline.currentTime;
                fw.T0(() => log.push('F', '+' + Math.round(document.timeline.currentTime - a)));
                setTimeout(() => log.push('P', '+' + Math.round(document.timeline.currentTime - a)), 0);
              }
              if (depth < 10) setTimeout(step, 0); else setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 100);
            }
            step();
          }, 50);
        };
      </script>
    HTML
    expect(log).to eq(%w[F +4 P +4])
  end

  # A frame's time origin is when its document was made — an initial about:blank one's as the frame was inserted — not
  # when a script first used its window, which makes its realm here. Chrome 156 (two runs): `1002 1001`; Firefox 159
  # within a ms of it.
  it "takes an about:blank frame's time origin as the frame is inserted" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>origin</title><pre id="out"></pre>
      <script>
        onload = () => setTimeout(() => {
          const a = document.createElement('iframe'); document.body.append(a);
          const b = document.createElement('iframe'); b.srcdoc = '<p>b'; document.body.append(b);
          setTimeout(() => {
            document.getElementById('out').textContent = [a, b].map((f) => Math.round(f.contentWindow.performance.now())).join(' ');
            document.title = 'done';
          }, 1000);
        }, 1000);
      </script>
    HTML
    expect(log.map(&:to_i)).to all(be_between(1000, 1010))
  end

  # A CSS animation a task started — a class set between two rendering updates — starts at the next update's commit,
  # after its animation frame callbacks, and owes its `animationstart` to the update after: the page's as its frame's.
  # The page's had been started, and its event sent, ahead of the callbacks. Chrome 156 and Firefox 159:
  # `P-raf F-raf P-start F-start`.
  it "sends a CSS animation's start after the animation frame callbacks of the update that started it" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>anim</title>
      <style>@keyframes k { from { opacity: 0 } to { opacity: 1 } } .a { animation: k 100ms linear }</style>
      <div id="pd">p</div>
      <iframe id="f" srcdoc="<style>@keyframes k { from { opacity: 0 } to { opacity: 1 } } .a { animation: k 100ms linear }</style><div id=d>f</div>"></iframe>
      <pre id="out"></pre>
      <script>
        const log = [];
        onload = () => {
          const fw = document.getElementById('f').contentWindow;
          const fd = fw.document.getElementById('d'), pd = document.getElementById('pd');
          setTimeout(() => {
            for (const [n, el] of [['F', fd], ['P', pd]]) el.addEventListener('animationstart', () => log.push(n + '-start'));
            fd.className = 'a'; pd.className = 'a';
            fw.requestAnimationFrame(() => log.push('F-raf'));
            requestAnimationFrame(() => log.push('P-raf'));
            setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 400);
          }, 50);
        };
      </script>
    HTML
    expect(log).to eq(%w[P-raf F-raf P-start F-start])
  end

  # A transition a task's style change made is pending until the update's commit, after that update's animation frame
  # callbacks — owing no event at that update's "update animations and send events", where a pending one was read as
  # running from its hold time and sent `transitionrun` and `transitionstart` ahead of the first callback. Its events
  # come at the next update, with the script animations' `ready` settled at the commit before them. Chrome 156:
  # `raf1 F-ready P-ready st=true run start raf2 raf3 P-finished end`; Firefox 159 sends `F-ready` after `start`, which
  # the order of two documents' promises leaves open.
  it "sends a pending transition's events after the first animation frame callbacks" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>ready</title>
      <style>#t { transition: opacity 100ms linear; opacity: 1 } #t.o { opacity: 0 }</style>
      <div id="e">e</div><div id="t">t</div>
      <iframe id="f" srcdoc="<div id=d>d</div>"></iframe>
      <pre id="out"></pre>
      <script>
        const log = [];
        onload = () => setTimeout(() => {
          const e = document.getElementById('e'), t = document.getElementById('t');
          const fd = document.getElementById('f').contentDocument.getElementById('d');
          for (const ev of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) t.addEventListener(ev, () => log.push(ev.slice(10)));
          const a = e.animate([{ opacity: 0 }, { opacity: 1 }], 100);
          const b = fd.animate([{ opacity: 0 }, { opacity: 1 }], 100);
          a.ready.then(() => log.push('P-ready'));
          b.ready.then(() => log.push('F-ready'));
          t.className = 'o';
          requestAnimationFrame(() => { log.push('raf1'); requestAnimationFrame(() => log.push('raf2')); });
          setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 400);
        }, 50);
      </script>
    HTML
    expect(log.first).to eq('raf1')
    expect(log - %w[F-ready]).to eq(%w[raf1 P-ready run start raf2 end])
    expect(log.index('F-ready')).to be < log.index('raf2')
  end

  # A transition a task's style flush made is pending at the next update, in the pending phase: idle to pending owes its
  # `transitionrun`, sent ahead of the animation frame callbacks, and a callback that then cancels it — taking it out of
  # `transition-property`, retargeting it, hiding or removing its element — owes its `transitioncancel` at the update
  # after, the `transitionrun` before it. It sent a lone `transitioncancel`, its `transitionrun` left to a commit that
  # never came. A transition made and removed in one task, and a CSS animation's, owe nothing of it. A cancel sorts at
  # the owner and generation it had just before it was cancelled, its element's place in tree order (css-transitions-2
  # §6.1) — one removed from the document after the rest — where it sorted after every started transition's events.
  # Firefox 159, and csim: `cancelRaf:run retarget:run hideRaf:run removeRaf:run raf1 cancelRaf:cancel retarget:cancel
  # retarget:run retarget:start hideRaf:cancel plain:run plain:start removeRaf:cancel raf2 retarget:end plain:end`;
  # Chrome 156 sends a `start` with each `run`, `removeSync:run start cancel` too, and its update's events in another
  # order.
  def transition_cases(which)
    run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>tc2</title>
      <style>
      .t { transition: opacity 100ms linear; opacity: 1 } .t.o { opacity: 0 } .t.o2 { opacity: 0.5 }
      @keyframes k { from { opacity: 0 } to { opacity: 1 } } .a { animation: k 100ms linear }
      </style>
      <div id="box"></div>
      <pre id="out"></pre>
      <script>
        const log = [];
        const evs = ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
        function mk(name) {
          const d = document.createElement('div'); d.className = 't'; d.textContent = name; document.getElementById('box').append(d);
          for (const ev of evs) d.addEventListener(ev, () => log.push(name + ':' + ev.replace(/^(transition|animation)/, '')));
          getComputedStyle(d).opacity;
          return d;
        }
        const cases = {
          cancelRaf(d) { d.classList.add('o'); requestAnimationFrame(() => { d.style.transition = 'none'; }); },
          retarget(d) { d.classList.add('o'); requestAnimationFrame(() => { d.classList.remove('o'); d.classList.add('o2'); }); },
          hideRaf(d) { d.classList.add('o'); requestAnimationFrame(() => { d.style.display = 'none'; }); },
          removeRaf(d) { d.classList.add('o'); requestAnimationFrame(() => { d.remove(); }); },
          removeSync(d) { d.classList.add('o'); getComputedStyle(d).opacity; d.remove(); },
          animCancelRaf(d) { d.classList.add('a'); requestAnimationFrame(() => { d.classList.remove('a'); }); },
          plain(d) { d.classList.add('o'); },
        };
        onload = () => setTimeout(() => {
          for (const n of #{which.to_json}) cases[n](mk(n));
          requestAnimationFrame(() => { log.push('raf1'); requestAnimationFrame(() => log.push('raf2')); });
          setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 400);
        }, 50);
      </script>
    HTML
  end

  it "sends a pending transition's run before the callbacks, and its cancel by one after them, in tree order" do
    expect(transition_cases(%w[cancelRaf retarget hideRaf removeRaf removeSync animCancelRaf plain])).to eq(
      %w[cancelRaf:run retarget:run hideRaf:run removeRaf:run raf1
         cancelRaf:cancel retarget:cancel retarget:run retarget:start hideRaf:cancel plain:run plain:start removeRaf:cancel
         raf2 retarget:end plain:end]
    )
  end

  # …a cancel before the started transition after it in tree order. Firefox 159 and csim:
  # `hideRaf:run plain:run raf1 hideRaf:cancel plain:start raf2 plain:end`.
  it "sorts a pending transition's cancel at its element's place" do
    expect(transition_cases(%w[hideRaf plain cancelRaf])).to eq(%w[hideRaf:run plain:run raf1 hideRaf:cancel plain:start raf2 plain:end])
  end

  # …and several transitions of one element and generation by their properties' names, cancelled as started: the code
  # points' order, `color opacity width`, where the cancels came in the order of the list that held them. Firefox 159:
  # `color:run opacity:run width:run color:start opacity:start width:start raf2 color:cancel opacity:cancel width:cancel`;
  # Chrome 156 sends them in the `transition` list's order, `width color opacity`.
  it "sorts one element's cancelled transitions by property name" do
    log = run(<<~HTML)
      <!DOCTYPE html><meta charset="utf-8"><title>multi</title>
      <style>
      .t { transition: opacity 100ms linear, color 100ms linear, width 100ms linear; opacity: 1; color: black; width: 10px }
      .t.o { opacity: 0; color: red; width: 20px }
      </style>
      <div id="m" class="t">m</div><pre id="out"></pre>
      <script>
        const log = [];
        onload = () => setTimeout(() => {
          const m = document.getElementById('m');
          for (const ev of ['transitionrun', 'transitionstart', 'transitioncancel']) m.addEventListener(ev, (e) => log.push(e.propertyName + ':' + ev.slice(10)));
          getComputedStyle(m).opacity;
          m.classList.add('o');
          getComputedStyle(m).opacity;
          requestAnimationFrame(() => requestAnimationFrame(() => { log.push('raf2'); m.style.transition = 'none'; }));
          setTimeout(() => { document.getElementById('out').textContent = log.join(' '); document.title = 'done'; }, 400);
        }, 50);
      </script>
    HTML
    expect(log).to eq(%w[color:run opacity:run width:run color:start opacity:start width:start raf2 color:cancel opacity:cancel width:cancel])
  end
end
