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

  # The resource selection's first step is NO_SOURCE at once; its mode is decided once the script has run: none — no
  # `src`, no `<source>` — EMPTY; a `<source>` child the children mode, `loadstart` and NO_SOURCE still (its resource is
  # not modelled), whatever `src` the load began with. Chrome: [3, 0, ""] and [3, 3, "emptied,loadstart"].
  # The parser's media element, its `src` set as it is made — no attribute change steps run there — loads as it is
  # inserted into the document (its network state EMPTY: HTML's resource selection on insertion): a resource that cannot
  # be fetched fails it (MEDIA_ERR_SRC_NOT_SUPPORTED, NETWORK_NO_SOURCE); one of no `src` stays EMPTY.
  it "loads the parser's media element as it is inserted" do
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
  # past them, which ends the wait at once (NETWORK_LOADING) and loads. Firefox: `[3, null]`, 2, then
  # `loadstart,error@b1,loadedmetadata` and NETWORK_IDLE. (Chrome keeps waiting, NETWORK_NO_SOURCE: the resource
  # selection algorithm's "wait until the node after pointer is a node other than the end of the list" says otherwise.)
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
    expect(s.evaluate_script(<<~'JS')).to eq(2)
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
    expect(s.evaluate_script(<<~'JS')).to eq([3, 2])
      (() => {
        v.prepend(Object.assign(document.createElement('source'), { src: 'm.webm?first' }));
        v.insertBefore(Object.assign(document.createElement('source'), { src: 'm.webm?between' }), v.lastChild);
        const early = v.networkState;
        v.lastChild.remove();
        v.append(Object.assign(document.createElement('source'), { src: 'm.webm?after' }));
        return [early, v.networkState];
      })()
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
