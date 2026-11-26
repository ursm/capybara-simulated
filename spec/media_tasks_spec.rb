# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A media element's events are media element tasks (media.rs): the load algorithm's `abort` and `emptied`, the resource
# selection's `loadstart`, and the media data processing's — the resource fetched whole (`progress`, NETWORK_IDLE,
# `suspend`), its metadata (HAVE_METADATA: `durationchange`, `resize`, `loadedmetadata`), then its data (HAVE_ENOUGH_DATA:
# `loadeddata`, `canplay`, `canplaythrough`) a task of its own, which a timer a `loadedmetadata` listener sets runs
# before; the document's load waiting for `loadeddata`. Chrome and Firefox (csim-bench img13 `m1`, `m3`, `m4`,
# 2026-11-27) where noted.
RSpec.describe 'media element tasks' do
  include PollUntil

  events = %w[
    loadstart progress suspend abort error emptied loadedmetadata loadeddata canplay canplaythrough durationchange
    timeupdate resize
  ]

  def media_page(body = '')
    video = File.binread(File.expand_path('wpt/media/movie_5.webm', __dir__))
    app = lambda {|env|
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      when '/m.webm' then [200, {'content-type' => 'video/webm'}, [video]]
      else [404, {'content-type' => 'text/plain'}, ['']]
      end
    }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  # Chrome and Firefox both: `n3r0` at once and at the microtask after `src` is set, the `loadstart` a task behind a
  # timer set first, `progress`/`suspend` before the metadata, `loadedmetadata` at HAVE_METADATA and `loadeddata` at
  # HAVE_ENOUGH_DATA, the timer the `loadedmetadata` listener set between them.
  it 'fires the media data processing events from tasks, with the ready states they come at' do
    s = media_page
    s.execute_script(<<~JS)
      window.log = [];
      const v = window.v = document.createElement('video');
      for (const t of #{events.to_json}) v.addEventListener(t, () => {
        log.push(t + ':' + v.networkState + v.readyState);
        if (t === 'loadedmetadata') setTimeout(() => log.push('T'), 0);
      });
      setTimeout(() => log.push('t0'), 0);
      v.src = '/m.webm';
      log.push('sync:' + v.networkState + v.readyState);
    JS
    poll_until { s.evaluate_script('log.includes("canplaythrough:14")') }
    expect(s.evaluate_script('log')).to eq(%w[
      sync:30 t0 loadstart:20 progress:20 suspend:10 durationchange:11 resize:11 loadedmetadata:11 T
      loadeddata:14 canplay:14 canplaythrough:14
    ])
  end

  # load() on a loaded element: `abort` and `emptied` (and `timeupdate`, its position not at the start — Firefox, HTML)
  # are tasks, none fired before the script that called it ends.
  it "queues the load algorithm's abort and emptied" do
    s = media_page
    s.execute_script(<<~JS)
      window.log = [];
      const v = window.v = document.createElement('video');
      v.oncanplaythrough = () => {
        v.oncanplaythrough = null;
        for (const t of ['abort', 'emptied', 'timeupdate', 'loadstart']) v.addEventListener(t, () => log.push(t));
        v.currentTime = 1;
        setTimeout(() => {
          log.length = 0;
          v.load();
          log.push('called');
          Promise.resolve().then(() => log.push('micro'));
        }, 50);
      };
      v.src = '/m.webm';
    JS
    poll_until { s.evaluate_script('log.includes("loadstart")') }
    expect(s.evaluate_script('log')).to eq(%w[called micro abort emptied timeupdate loadstart])
  end

  # A parsed `<video>` with `<source>`s: the failing candidates' `error`s after its `loadstart`, and the window's `load`
  # only once it has its first frame (HTML: its delaying-the-load-event flag; Chrome fires it after `canplaythrough`).
  it 'delays the document load until the element has its data' do
    s = media_page(<<~HTML)
      <video id=v><source id=s1 src="/nope.webm"><source id=s2 type="video/x-nope" src="/m.webm"><source id=s3 src="/m.webm"></video>
      <script>
        window.log = [];
        const v = document.getElementById('v');
        for (const t of ['loadstart', 'loadedmetadata', 'loadeddata']) v.addEventListener(t, () => log.push(t));
        for (const s of v.children) s.addEventListener('error', () => log.push(s.id + ' error'));
        addEventListener('load', () => log.push('window load ' + v.readyState));
      </script>
    HTML
    poll_until { s.evaluate_script('log.some((e) => e.startsWith("window"))') }
    expect(s.evaluate_script('log')).to eq(['loadstart', 's1 error', 's2 error', 'loadedmetadata', 'loadeddata', 'window load 4'])
  end

  # A parsed `<video>`: each stage of its media data processing a task of its own — a timer its `loadedmetadata` listener
  # sets runs before its `loadeddata` — the window's `load` after it (Chrome and Firefox, csim-bench img13 `m8`).
  it "runs a parsed element's stages as tasks of their own before the window's load" do
    s = media_page(<<~HTML)
      <video id=v src="/m.webm"></video>
      <script>
        window.log = [];
        const v = document.getElementById('v');
        v.addEventListener('loadedmetadata', () => { log.push('loadedmetadata'); setTimeout(() => log.push('T'), 0); });
        v.addEventListener('loadeddata', () => log.push('loadeddata'));
        addEventListener('load', () => log.push('window load'));
      </script>
    HTML
    poll_until { s.evaluate_script('log.includes("window load")') }
    expect(s.evaluate_script('log')).to eq(['loadedmetadata', 'T', 'loadeddata', 'window load'])
  end

  # The autoplay policy Chrome and Firefox share (csim-bench img13 `m9`): play() of an audible element on a page no user
  # has interacted with is rejected with a NotAllowedError, a muted one's or one at volume 0 not; a pending play promise
  # is rejected with an AbortError by a pause() before it plays, and resolved as it plays (rv `playp`); load() puts the
  # playback rate back to the default one (rv `rate`).
  it 'keeps the autoplay policy and settles play promises' do
    s = media_page
    s.execute_script(<<~'JS')
      window.log = [];
      const mk = () => { const v = document.createElement('video'); v.src = '/m.webm'; return v; };
      mk().play().then(() => log.push('audible played'), (e) => log.push('audible ' + e.name));
      const quiet = mk(); quiet.volume = 0;
      quiet.play().then(() => log.push('volume 0 played'), (e) => log.push('volume 0 ' + e.name));
      const m = mk(); m.muted = true;
      m.play().then(() => log.push('p1 resolved'), (e) => log.push('p1 ' + e.name));
      m.pause();
      m.oncanplaythrough = () => { m.oncanplaythrough = null; m.play().then(() => log.push('p2 resolved'), (e) => log.push('p2 ' + e.name)); };
      const r = mk(); r.playbackRate = 2; r.load(); log.push('rate ' + r.playbackRate);
    JS
    poll_until { s.evaluate_script('log.length') >= 5 }
    expect(s.evaluate_script('log').sort).to eq(['audible NotAllowedError', 'p1 AbortError', 'p2 resolved', 'rate 1', 'volume 0 played'])
  end
end
