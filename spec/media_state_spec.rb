# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A media element's state, the engine's (media.rs): what its members read back, and the network state its load
# algorithm and resource selection leave — each figure Chrome's.
RSpec.describe 'Media element state' do
  def session
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|s| s.visit '/' }
  end

  # A write that reads the same is no change: -0 after 0 reads back 0, and fires no `ratechange` / `volumechange`; a seek
  # reads -0 as 0. Chrome: [false, false, false, 0].
  it 'reads -0 written over 0 back as 0' do
    expect(session.evaluate_script(<<~'JS')).to eq([false, false, false, 0])
      (() => {
        const v = document.createElement('video');
        let events = 0;
        v.addEventListener('ratechange', () => events++);
        v.addEventListener('volumechange', () => events++);
        v.playbackRate = 0;
        v.volume = 0;
        events = 0;
        v.playbackRate = -0;
        v.volume = -0;
        v.currentTime = -0;
        return [Object.is(v.playbackRate, -0), Object.is(v.volume, -0), Object.is(v.currentTime, -0), events];
      })()
    JS
  end

  # A seek with no media data is the default playback start position, which `currentTime` reads and a load keeps (HTML
  # §4.8.11.8). Chrome: 3, then `emptied,timeupdate`.
  it 'keeps a seek made before there is media data across a load' do
    s = session
    s.execute_script(<<~'JS')
      const v = window.v = document.createElement('video');
      v.currentTime = 3;
      v.src = 'a.mp4';
      window.events = [];
      for (const t of ['timeupdate', 'emptied', 'abort']) v.addEventListener(t, () => events.push(t));
      v.load();
    JS
    expect(s.evaluate_script('[v.currentTime, events.join()]')).to eq([3, 'emptied,timeupdate'])
  end

  # …and once there is media data, the position seeks to it where it is past 0 (`seeked` after `loadedmetadata`), and it
  # is 0 whatever it was — a negative one reads 0 then, and no longer stands in for a later seek. Chrome: -1 before the
  # data, 0 after it.
  it 'applies the default playback start position as the media data comes' do
    video = File.binread(File.expand_path('wpt/media/movie_5.webm', __dir__))
    app = lambda {|env|
      next [200, {'content-type' => 'video/webm'}, [video]] if env['PATH_INFO'] == '/m.webm'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    }
    s = simulated_session(app).tap {|session| session.visit '/' }
    s.execute_script(<<~'JS')
      window.events = [];
      window.negative = document.createElement('video');
      negative.currentTime = -1;
      window.before = negative.currentTime;
      negative.src = 'm.webm';
      window.positive = document.createElement('video');
      positive.currentTime = 3;
      for (const t of ['loadedmetadata', 'seeked', 'loadeddata']) positive.addEventListener(t, () => events.push(t));
      positive.src = 'm.webm';
    JS
    expect(s.evaluate_script('[before, negative.readyState, negative.currentTime]')).to eq([-1, 4, 0])
    s.execute_script('negative.currentTime = 2')
    expect(s.evaluate_script('[negative.currentTime, positive.currentTime, positive.networkState, events.join()]')).to eq([2, 3, 1, 'loadedmetadata,seeked,loadeddata'])
  end

  # The parser's media element, its `src` set as it is made — no attribute change steps run there — invokes its resource
  # selection as it is created: a resource that cannot be fetched fails it (MEDIA_ERR_SRC_NOT_SUPPORTED,
  # NETWORK_NO_SOURCE); one of no `src` stays EMPTY.
  it "loads the parser's media element as it is created" do
    page = '<!DOCTYPE html><meta charset=utf-8><body><video id=v src="/missing.webm"></video><video id=e></video>'
    s = simulated_session(lambda {|env|
      env['PATH_INFO'] == '/' ? [200, {'content-type' => 'text/html'}, [page]] : [404, {'content-type' => 'text/plain'}, ['no']]
    }).tap {|session| session.visit '/' }
    got = s.evaluate_async_script(<<~'JS')
      const done = arguments[0], v = document.getElementById('v'), e = document.getElementById('e');
      const report = () => done([v.error && v.error.code, v.networkState, e.networkState]);
      if (v.error) report(); else v.addEventListener('error', report);
    JS
    expect(got).to eq([4, 3, 0])
  end

  # The resource selection's first step is NO_SOURCE at once; its mode is decided once the script has run: none — no
  # `src`, no `<source>` — EMPTY; a `<source>` child the children mode, `loadstart` and — that `<source>` with no `src`
  # failing — NO_SOURCE, waiting for another, whatever `src` the load began with. Chrome: [3, 0, ""] and
  # [3, 3, "emptied,loadstart"].
  it 'decides the resource selection mode as the stable state comes' do
    s = session
    s.execute_script(<<~'JS')
      window.bare = document.createElement('video');
      window.bareEvents = [];
      bare.addEventListener('loadstart', () => bareEvents.push('loadstart'));
      bare.load();
      window.bareSync = bare.networkState;
      window.sourced = document.createElement('video');
      sourced.appendChild(document.createElement('source'));
      window.sourcedEvents = [];
      for (const t of ['loadstart', 'error', 'abort', 'emptied']) sourced.addEventListener(t, () => sourcedEvents.push(t));
      sourced.src = 'nothing.mp4';
      sourced.removeAttribute('src');
      window.sourcedSync = sourced.networkState;
    JS
    expect(s.evaluate_script('[bareSync, bare.networkState, bareEvents.join()]')).to eq([3, 0, ''])
    expect(s.evaluate_script('[sourcedSync, sourced.networkState, sourcedEvents.join()]')).to eq([3, 3, 'emptied,loadstart'])
  end

  # A page that serves a video at `/m.webm` (any query) and a 404 elsewhere, `requests` the paths and queries it was
  # asked for.
  def media_session(requests = [])
    video = File.binread(File.expand_path('wpt/media/movie_5.webm', __dir__))
    app = lambda {|env|
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      when '/m.webm' then requests << "m.webm?#{env['QUERY_STRING']}"; [200, {'content-type' => 'video/webm'}, [video]]
      else requests << env['PATH_INFO'][1..]; [404, {'content-type' => 'text/plain'}, ['']]
      end
    }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  # The children mode tries the `<source>` children in tree order: one with no `src`, an empty one or a `type` the
  # element cannot play fails at once, and one whose fetch fails fails too — each with an `error` at the `<source>`, none
  # at the element — until one loads. Chrome and Firefox: `loadstart,error@a1,error@a2,error@a3,error@a4,loadedmetadata`
  # (with `suspend`s of their buffering, which nothing here models), NETWORK_IDLE, the last candidate the current source.
  it 'loads the first <source> child that does not fail, the ones before it failing' do
    requests = []
    s = media_session(requests)
    s.execute_script(<<~'JS')
      window.log = [];
      const v = window.v = document.createElement('video');
      v.innerHTML = '<source id=a1><source id=a2 src=""><source id=a3 src="m.webm?1" type="video/x-nope">' +
        '<source id=a4 src="missing.webm"><source id=a5 src="m.webm?5"><source id=a6 src="m.webm?6">';
      for (const el of [v, ...v.children]) {
        for (const t of ['loadstart', 'error', 'loadedmetadata']) el.addEventListener(t, () => log.push(t + (el.id ? '@' + el.id : '')));
      }
      document.body.append(v);
    JS
    expect(s.evaluate_script('log.includes("loadedmetadata")')).to be true
    expect(s.evaluate_script('[log.join(), v.networkState, v.error, v.currentSrc.split("/").pop()]')).to eq([
      'loadstart,error@a1,error@a2,error@a3,error@a4,loadedmetadata', 1, nil, 'm.webm?5'
    ])
    expect(requests).to eq(['missing.webm', 'm.webm?5'])
  end

  # …and with every candidate failed it waits — NETWORK_NO_SOURCE, no error at the element — for a `<source>` inserted
  # past them, which ends the wait: NETWORK_LOADING as the stable state comes (the algorithm awaits one before it sets
  # it — Firefox reads 2 right after the insertion), and it loads. Firefox: `[3, null]`, then
  # `loadstart,error@b1,loadedmetadata` and NETWORK_IDLE. (Chrome keeps waiting: the algorithm's "wait until the node
  # after pointer is a node other than the end of the list" says otherwise.)
  it 'waits for a <source> inserted past the candidates that failed' do
    s = media_session
    s.execute_script(<<~'JS')
      window.log = [];
      const v = window.v = document.createElement('video');
      v.innerHTML = '<source id=b1 src="missing.webm">';
      for (const el of [v, v.firstChild]) {
        for (const t of ['loadstart', 'error', 'loadedmetadata']) el.addEventListener(t, () => log.push(t + (el.id ? '@' + el.id : '')));
      }
      document.body.append(v);
    JS
    expect(s.evaluate_script('log.join()')).to eq('loadstart,error@b1')
    expect(s.evaluate_script('[v.networkState, v.error]')).to eq([3, nil])
    expect(s.evaluate_script(<<~'JS')).to eq(3)
      (() => {
        const source = document.createElement('source');
        source.src = 'm.webm?b';
        v.append(source);
        return v.networkState;
      })()
    JS
    expect(s.evaluate_script('log.includes("loadedmetadata")')).to be true
    expect(s.evaluate_script('[log.join(), v.networkState, v.currentSrc.split("/").pop()]')).to eq([
      'loadstart,error@b1,loadedmetadata', 1, 'm.webm?b'
    ])
  end

  # …past the pointer only: a `<source>` inserted BEFORE the last failed candidate — at an index past where that one
  # stood when it failed — ends no wait; one inserted after it, that one removed first and the pointer where it was,
  # does.
  it 'ends the wait only for a <source> inserted past the pointer' do
    s = media_session
    s.execute_script(<<~'JS')
      window.v = document.createElement('video');
      v.innerHTML = '<source id=c1 src="missing.webm"><source id=c2 src="missing.webm?2">';
      document.body.append(v);
    JS
    expect(s.evaluate_script('v.networkState')).to eq(3)
    s.execute_script(<<~'JS')
      v.prepend(Object.assign(document.createElement('source'), { src: 'm.webm?first' }));
      v.insertBefore(Object.assign(document.createElement('source'), { src: 'm.webm?between' }), v.lastChild);
    JS
    expect(s.evaluate_script('[v.networkState, v.readyState, v.currentSrc.split("/").pop()]')).to eq([3, 0, 'missing.webm?2'])
    s.execute_script(<<~'JS')
      v.lastChild.remove();
      v.append(Object.assign(document.createElement('source'), { src: 'm.webm?after' }));
    JS
    expect(s.evaluate_script('v.readyState')).to eq(4)
    expect(s.evaluate_script('v.currentSrc.split("/").pop()')).to eq('m.webm?after')
  end

  # `preload` none puts the fetch off until the element plays: `loadstart` and `suspend`, NETWORK_IDLE with no media data
  # and nothing fetched; `play()` fetches it. `autoplay` overrides it. Chrome and Firefox: `loadstart,suspend` and
  # `[1, 0, "m.webm?c"]` — the `autoplay` one at HAVE_ENOUGH_DATA — then `play,waiting`, a `suspend` of their buffering
  # and `loadedmetadata`, `[1, 4]`.
  it 'fetches nothing for preload none until the element plays, unless it autoplays' do
    requests = []
    s = media_session(requests)
    s.execute_script(<<~'JS')
      window.log = [];
      const v = window.v = document.createElement('video');
      v.preload = 'NONE';
      for (const t of ['loadstart', 'suspend', 'play', 'waiting', 'loadedmetadata']) v.addEventListener(t, () => log.push(t));
      v.src = 'm.webm?c';
      const auto = window.auto = document.createElement('video');
      auto.preload = 'none';
      auto.autoplay = true;
      auto.src = 'm.webm?e';
    JS
    expect(s.evaluate_script('auto.readyState')).to eq(4)
    expect(s.evaluate_script('[log.join(), v.networkState, v.readyState, v.currentSrc.split("/").pop()]')).to eq([
      'loadstart,suspend', 1, 0, 'm.webm?c'
    ])
    expect(requests).to eq(['m.webm?e'])
    s.execute_script('v.play()')
    expect(s.evaluate_script('log.includes("loadedmetadata")')).to be true
    expect(s.evaluate_script('[log.slice(0, 5).join(), v.networkState, v.readyState]')).to eq([
      'loadstart,suspend,play,waiting,loadedmetadata', 1, 4
    ])
    expect(requests).to eq(['m.webm?e', 'm.webm?c'])
  end

  # Resource selection is invoked as an element is CREATED with a `src` — the parser's, a fragment's, a clone's — wherever
  # it is, not as it is inserted: a src-less one appended stays NETWORK_EMPTY, and a `src` set on it then loads it with
  # no `emptied`. A document with no browsing context loads nothing: its fetch fails. Chrome (and Firefox where noted):
  # `[0, "loadstart,error"]`; a detached `innerHTML` video 3 at once and loaded, a clone loaded again (both); a template's
  # and a `createHTMLDocument` one's 3 with nothing fetched, the latter's error 4 (both).
  it 'invokes resource selection as an element is created with a src, loading nothing with no browsing context' do
    requests = []
    s = media_session(requests)
    s.execute_script(<<~'JS')
      window.log = [];
      const v = window.v = document.createElement('video');
      document.body.append(v);
      window.appended = v.networkState;
      for (const t of ['emptied', 'loadstart', 'error']) v.addEventListener(t, () => log.push(t));
      v.src = 'missing.webm';
    JS
    expect(s.evaluate_script('[appended, log.join()]')).to eq([0, 'loadstart,error'])
    expect(s.evaluate_script(<<~'JS')).to eq(3)
      (() => {
        const div = document.createElement('div');
        div.innerHTML = '<video src="m.webm?detached"></video>';
        window.detached = div.firstChild;
        return detached.networkState;
      })()
    JS
    expect(s.evaluate_script('detached.readyState')).to eq(4)
    expect(s.evaluate_script('(window.copy = detached.cloneNode()).networkState')).to eq(3)
    expect(s.evaluate_script('copy.readyState')).to eq(4)
    s.execute_script(<<~'JS')
      const t = document.createElement('template');
      t.innerHTML = '<video src="m.webm?template"></video>';
      window.inert = t.content.firstChild;
      const d = document.implementation.createHTMLDocument('');
      d.body.innerHTML = '<video src="m.webm?doc"></video><audio src="m.webm?docaudio"></audio>';
      window.unloaded = [...d.body.children];
    JS
    expect(s.evaluate_script('[inert.networkState, ...unloaded.map((m) => [m.networkState, m.error && m.error.code])]')).to eq([
      3, [3, 4], [3, 4]
    ])
    expect(requests).to eq(['missing.webm', 'm.webm?detached', 'm.webm?detached'])
  end

  # `preload` none's fetch is put off only until the page asks the element to play — a `play()` before the stable
  # state included, and for each candidate after the first fails — and a candidate removed before its fetch fails
  # owes no `error` at the element (nor at the removed `<source>`): the next one is tried. Chrome: each loads.
  it 'fetches a preload none resource once the page asked it to play, the next candidates too' do
    requests = []
    s = media_session(requests)
    s.execute_script(<<~'JS')
      window.early = document.createElement('video');
      early.preload = 'none';
      early.src = 'm.webm?early';
      early.play();
      window.next = document.createElement('video');
      next.preload = 'none';
      next.innerHTML = '<source src="missing.webm"><source src="m.webm?next">';
      window.removed = document.createElement('video');
      removed.preload = 'none';
      removed.innerHTML = '<source src="missing.webm"><source src="m.webm?after-removed">';
      window.log = [];
      removed.firstChild.addEventListener('error', () => log.push('source'));
      removed.addEventListener('error', () => log.push('element'));
    JS
    expect(s.evaluate_script('[early.readyState, next.networkState, removed.networkState]')).to eq([4, 1, 1])
    s.execute_script('next.play(); removed.firstChild.remove(); removed.play()')
    expect(s.evaluate_script('[next.readyState, next.currentSrc.split("/").pop()]')).to eq([4, 'm.webm?next'])
    expect(s.evaluate_script('[removed.readyState, removed.error, log.join()]')).to eq([4, nil, ''])
    expect(requests).to eq(['m.webm?early', 'missing.webm', 'm.webm?next', 'missing.webm', 'm.webm?after-removed'])
  end

  # A candidate's `type` decides only where it names one — an empty one names none — and its `media` must match the
  # viewport. Chrome and Firefox load `type=""`; Chrome fires `error` at a `media` that does not match and loads the next.
  it 'takes a <source> with an empty type and skips one whose media does not match' do
    s = media_session
    s.execute_script(<<~'JS')
      window.typed = document.createElement('video');
      typed.innerHTML = '<source type="" src="m.webm?typed">';
      window.log = [];
      window.mediaq = document.createElement('video');
      mediaq.innerHTML = '<source media="(max-width: 1px)" src="m.webm?narrow"><source src="m.webm?wide">';
      mediaq.firstChild.addEventListener('error', () => log.push('narrow'));
    JS
    expect(s.evaluate_script('[typed.readyState, mediaq.readyState, mediaq.currentSrc.split("/").pop(), log.join()]')).to eq([
      4, 4, 'm.webm?wide', 'narrow'
    ])
  end

  # An audio's response decides its load, an uncontrolled document's too: a 404 candidate fails — its `error` at the
  # `<source>` — and the next one's response is usable, the readiness ladder to `canplaythrough`.
  it 'decides an uncontrolled audio load by its response' do
    requests = []
    s = media_session(requests)
    s.execute_script(<<~'JS')
      window.log = [];
      const a = window.a = document.createElement('audio');
      a.innerHTML = '<source id=a1 src="missing.mp3"><source id=a2 src="m.webm?audio">';
      for (const el of [a, ...a.children]) for (const t of ['error', 'canplaythrough']) el.addEventListener(t, () => log.push(t + (el.id ? '@' + el.id : '')));
    JS
    expect(s.evaluate_script('[log.join(), a.networkState, a.currentSrc.split("/").pop()]')).to eq([
      'error@a1,canplaythrough', 1, 'm.webm?audio'
    ])
    expect(requests).to eq(['missing.mp3', 'm.webm?audio'])
  end

  # The internal pause steps run only for a playing element: `pause()` on a paused one fires neither `timeupdate` nor
  # `pause`. Chrome: [true, ''].
  it 'fires nothing for a pause of a paused element' do
    s = session
    s.execute_script(<<~'JS')
      window.v = document.createElement('video');
      window.log = [];
      for (const t of ['play', 'playing', 'waiting', 'pause', 'timeupdate']) v.addEventListener(t, () => log.push(t));
      v.pause(); v.pause();
    JS
    expect(s.evaluate_script('[v.paused, log.join()]')).to eq([true, ''])
  end
end
