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
end
