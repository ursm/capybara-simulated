# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A subresource's request is the engine's plan of it (subresource_plan.rs `plan`): a module script's options carry its
# own `referrerpolicy` alone, so a later `import()` takes its document's policy as it is then (Fetch "main fetch"); and a
# link's request takes its `crossorigin` as its load task runs — one set right after the link is inserted is the one
# its one fetch is made with. That is the driver's model of a link's fetch (a task after insertion), not the platform's:
# HTML begins a sheet's fetch as the link is inserted, and a `crossorigin` change fetches it again — a backlog item.
RSpec.describe 'a subresource request plan' do
  include PollUntil

  let(:seen) { [] }
  let(:session) do
    simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_REFERER'], env['HTTP_ORIGIN']]
      case env['PATH_INFO']
      when '/m.js' then [200, {'content-type' => 'text/javascript'}, ["window.later = () => import('/d.js');"]]
      when '/d.js', '/p.js' then [200, {'content-type' => 'text/javascript', 'access-control-allow-origin' => '*'}, ['export {};']]
      when '/c.css' then [200, {'content-type' => 'text/css', 'access-control-allow-origin' => '*'}, ['p { color: red }']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
          <script type="module" src="/m.js"></script>
        HTML
      end
    })
  end

  it "takes a module's document's policy as a later import is made" do
    session.visit '/'
    session.execute_script(<<~JS)
      document.querySelector('meta[name=referrer]').content = 'unsafe-url';
      window.done = false;
      window.later().then(() => { window.done = true; });
    JS
    expect(poll_until { session.evaluate_script('window.done') }).to be(true)
    expect(seen.assoc('/d.js')[1]).to eq('http://www.example.com/m.js')
  end

  it "fetches a link once, with the crossorigin set before its load task ran" do
    session.visit '/'
    session.execute_script(<<~JS)
      for (const [rel, href] of [['preload', '/p.js'], ['stylesheet', '/c.css']]) {
        const link = document.createElement('link');
        link.rel = rel;
        if (rel === 'preload') link.as = 'script';
        link.href = href;
        document.head.append(link);
        link.crossOrigin = 'anonymous';
      }
    JS
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(seen.select {|(path, _, _)| %w[/p.js /c.css].include?(path) }.map(&:first).sort).to eq(%w[/c.css /p.js])
  end
  # A media element's shown track is fetched by the media element's `crossorigin` (HTML's track processing model): a
  # CORS request — its Origin sent to the other origin — under a `crossorigin` video, and under one of none a same-origin
  # request (its potential-CORS request's same-origin fallback), which another origin's URL is a network error of: none
  # sent — a `crossorigin` on the track itself, which has no such attribute, nothing.
  it "fetches a track by its media element's crossorigin" do
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin served in-process
    session.visit '/'
    session.execute_script(<<~JS)
      for (const [name, on] of [['video', true], ['track', false]]) {
        const video = document.createElement('video');
        video.preload = 'none';
        const track = document.createElement('track');
        track.default = true;
        track.src = 'http://other.test/' + name + '.vtt';
        if (on) video.crossOrigin = 'anonymous'; else track.setAttribute('crossorigin', 'anonymous');
        video.append(track);
        document.body.append(video);
      }
    JS
    poll_until { session.evaluate_script('1') && seen.any? {|(path, _, _)| path.end_with?('.vtt') } }
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    tracks = seen.select {|(path, _, _)| path.end_with?('.vtt') }
    expect(tracks.map {|(path, _, origin)| [path, origin] }).to eq([['/video.vtt', 'http://www.example.com']])
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end
  # …and its poster a plain request whatever its `crossorigin` (HTML's poster frame steps), as an image input's is: an
  # `<input type=image>` has no CORS settings attribute — no Origin sent to the other origin for either.
  it "fetches a poster and an image input as no CORS request" do
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin served in-process
    session.visit '/'
    session.execute_script(<<~JS)
      const video = document.createElement('video');
      video.preload = 'none';
      video.crossOrigin = 'anonymous';
      video.poster = 'http://other.test/poster.png';
      document.body.append(video);
      const input = document.createElement('input');
      input.type = 'image';
      input.setAttribute('crossorigin', 'anonymous');
      input.src = 'http://other.test/input.png';
      document.body.append(input);
    JS
    got = poll_until { session.evaluate_script('1') && (hit = seen.select {|(path, _, _)| path.end_with?('.png') }).size == 2 && hit.sort }
    expect(got.map {|(path, _, origin)| [path, origin] }).to eq([['/input.png', nil], ['/poster.png', nil]])
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end
  # An image loaded before any page is: its client the page that is none yet, its request made all the same.
  it 'fetches an image before any visit' do
    session.execute_script("new Image().src = 'http://www.example.com/pre.png'")
    expect(poll_until { session.evaluate_script('1') && seen.assoc('/pre.png') }).to be_truthy
  end
end

