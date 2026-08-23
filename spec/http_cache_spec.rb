# frozen_string_literal: true

require 'capybara/simulated'
require 'vips'
require_relative 'support/session_teardown'

# The HTTP cache as a test sees it across sessions: what `reset!` keeps (a persistent browser
# profile's fresh `immutable` entries), what `Driver#clear_http_cache` gives back (a fresh
# Playwright / Cuprite context's cold cache), and that the decoded-image memo is keyed by the
# BYTES — a URL whose image changed is the HTTP cache's question, never a stale bitmap.
RSpec.describe 'HTTP cache across sessions' do
  # The cache is process-wide: leave it as cold as this file found it, so the `/a.css` these
  # examples plant can't shadow another spec's response at the same path.
  after do
    Capybara::Simulated.clear_http_cache
  end

  def png(width, height)
    Vips::Image.black(width, height, bands: 3).write_to_buffer('.png')
  end

  def wait_for_image(session, id)
    expect(session.evaluate_async_script(<<~JS, id)).to eq('loaded')
      const cb = arguments[arguments.length - 1];
      const img = document.getElementById(arguments[0]);
      if (img.complete) { cb('loaded'); } else {
        img.addEventListener('load', () => cb('loaded'));
        img.addEventListener('error', () => cb('error'));
      }
    JS
  end

  it 'keeps an immutable stylesheet across reset! until the cache is cleared' do
    color = 'rgb(255, 0, 0)'
    app = lambda {|env|
      if env['PATH_INFO'] == '/a.css'
        [200, {'content-type' => 'text/css', 'cache-control' => 'public, max-age=31536000, immutable'}, ["p{color:#{color}}"]]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><link rel="stylesheet" href="/a.css"><p id="p">x</p>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.find('#p').style('color')).to eq('color' => 'rgb(255, 0, 0)')

    # The server now has new bytes at the SAME immutable URL (what a digest built from a
    # rolled-back DB row does). A persistent profile keeps serving the old ones …
    color = 'rgb(0, 0, 255)'
    s.reset!
    s.visit '/'
    expect(s.find('#p').style('color')).to eq('color' => 'rgb(255, 0, 0)')

    # … and a cold cache fetches them.
    s.driver.clear_http_cache
    s.reset!
    s.visit '/'
    expect(s.find('#p').style('color')).to eq('color' => 'rgb(0, 0, 255)')
  end

  it 'decodes the new bytes when an image behind a no-store URL changes' do
    image = png(80, 40)
    app = lambda {|env|
      if env['PATH_INFO'] == '/i.png'
        [200, {'content-type' => 'image/png', 'cache-control' => 'no-store'}, [image]]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><img id="i" src="/i.png">']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    wait_for_image(s, 'i')
    expect(s.evaluate_script('document.getElementById("i").naturalWidth')).to eq(80)

    image = png(40, 20)
    s.visit '/'
    wait_for_image(s, 'i')
    expect(s.evaluate_script('document.getElementById("i").naturalWidth')).to eq(40)
  end
end
