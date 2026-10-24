# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# The destination and mode a subresource's request reports in its Fetch Metadata (Fetch Metadata Request Headers): a
# font's `font` (CSS Fonts 4 §4.9.1, a CORS request), a worker's script `worker` / `sharedworker` (HTML "fetch a classic
# worker script"), a script it imports `script` ("fetch a classic worker-imported script"), and a beacon's mode
# "no-cors" unless its body's Content-Type is no CORS-safelisted one (Beacon "sendBeacon"); a plugin's resource a
# navigation request of its element's destination (HTML `embed` / `object`), its element's `load` fired as it is in —
# an `object`'s `error` for a response that is no ok one — and a media element's poster an image's, its data its own.
RSpec.describe 'a subresource request', :https do
  include PollUntil

  let(:seen) { {} }
  let(:seen_site) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_DEST'], env['HTTP_SEC_FETCH_MODE']]
      seen_site[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_SITE'], env['HTTP_REFERER']]
      case env['PATH_INFO']
      when '/w.js', '/sw.js' then [200, {'content-type' => 'text/javascript'}, ["importScripts('/i.js'); postMessage(1);"]]
      when '/i.js', '/m2.js', '/d3.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      when '/mw.js' then [200, {'content-type' => 'text/javascript'}, ["import './m2.js'; import('./d2.js');"]]
      when '/d2.js' then [200, {'content-type' => 'text/javascript'}, ["import './d3.js';"]]
      when '/f.woff', '/gone' then [404, {}, ['']]
      when '/e.svg', '/o.svg', '/poster.png', '/a.mp3' then [200, {'content-type' => 'image/svg+xml'}, ['<svg xmlns="http://www.w3.org/2000/svg"/>']]
      else [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8>
        <style>@font-face { font-family: F; src: url(/f.woff); } p { font-family: F; }</style><p>x</p>
      HTML
      end
    })
  end

  it 'reports its destination and mode' do
    session.visit '/'
    session.execute_script(<<~JS)
      document.fonts.load('16px F');
      new Worker('/w.js');
      new SharedWorker('/sw.js');
      navigator.sendBeacon('/plain', 'x');
      navigator.sendBeacon('/json', new Blob(['{}'], {type: 'application/json'}));
    JS
    expect(poll_until { seen.size >= 7 && seen.except('/') }).to eq(
      '/f.woff' => %w[font cors],
      '/w.js'   => %w[worker same-origin],
      '/sw.js'  => %w[sharedworker same-origin],
      '/i.js'   => %w[script no-cors],
      '/plain'  => %w[empty no-cors],
      '/json'   => %w[empty cors]
    )
  end

  # (…and a worker's import of its own: the worker the client, an opaque one's site cross-site, its URL no referrer)
  it "sends a data: worker's import as its own" do
    session.visit '/'
    session.execute_script(%q{new Worker('data:text/javascript,importScripts("' + location.origin + '/i.js")')})
    expect(poll_until { seen['/i.js'] }).to eq(%w[script no-cors])
    expect(seen_site['/i.js']).to eq(['cross-site', nil])
  end

  # (…a module worker's graph of its destination, an `import()` and what that imports a script's)
  it "fetches a module worker's graph as the worker, its import() as a script" do
    session.visit '/'
    session.execute_script("new Worker('/mw.js', {type: 'module'})")
    expect(poll_until { seen['/d3.js'] && seen.slice('/mw.js', '/m2.js', '/d2.js', '/d3.js') }).to eq(
      '/mw.js' => %w[worker same-origin],
      '/m2.js' => %w[worker cors],
      '/d2.js' => %w[script cors],
      '/d3.js' => %w[script cors]
    )
  end

  it "fetches a plugin's resource as a navigation and a media element's as their destinations" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      for (const [tag, attr, url] of [['embed', 'src', '/e.svg'], ['object', 'data', '/o.svg'], ['object', 'data', '/gone']]) {
        const el = document.createElement(tag);
        el.addEventListener('load', () => events.push(`load ${url}`));
        el.addEventListener('error', () => events.push(`error ${url}`));
        el.setAttribute(attr, url);
        document.body.append(el);
      }
      document.body.insertAdjacentHTML('beforeend', '<video poster="/poster.png"></video><audio src="/a.mp3"></audio>');
    JS
    expect(poll_until { session.evaluate_script('events.length') == 3 && session.evaluate_script('events.sort()') }).to eq(['error /gone', 'load /e.svg', 'load /o.svg'])
    expect(seen.slice('/e.svg', '/o.svg', '/poster.png', '/a.mp3')).to eq(
      '/e.svg'      => %w[embed navigate],
      '/o.svg'      => %w[object navigate],
      '/poster.png' => %w[image no-cors],
      '/a.mp3'      => %w[audio no-cors]
    )
  end

  # (…each time its processing runs: a second element of the same resource, one inserted again, a resource set after
  # its insertion — and one no network answers loaded all the same)
  it "fires a plugin's load each time its processing runs" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      const make = (tag, label) => {
        const el = document.createElement(tag);
        el.addEventListener('load', () => events.push(`load ${label}`));
        el.addEventListener('error', () => events.push(`error ${label}`));
        return el;
      };
      for (const label of ['a', 'b']) { const e = make('embed', label); e.src = '/e.svg'; document.body.append(e); }
      window.again = make('object', 'again');
      again.data = '/o.svg';
      document.body.append(again);
      const late = make('object', 'late');
      document.body.append(late);
      late.data = '/o.svg';
      const local = make('object', 'data');
      local.data = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      document.body.append(local);
    JS
    expect(poll_until { session.evaluate_script('events.length') == 5 && session.evaluate_script('events.sort()') }).to eq(
      ['load a', 'load again', 'load b', 'load data', 'load late']
    )
    session.execute_script('again.remove(); document.body.append(again)')
    expect(poll_until { session.evaluate_script('events.length') == 6 && session.evaluate_script('events.at(-1)') }).to eq('load again')
  end

  it 'refuses a beacon over the keepalive quota' do
    session.visit '/'
    expect(session.evaluate_script("['x'.repeat(70000), 'x'.repeat(40000)].map((d, i) => navigator.sendBeacon('/q' + i, d))")).to eq([false, true])
  end
end
