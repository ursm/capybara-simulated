# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# The blob URL store is the isolate's (blob_urls.rs): one entry a URL, the realm that made it beside it — and its
# window's registry (blob_registry.rs), which its other contexts, a worker's isolate, resolve it in.
RSpec.describe 'the blob URL store' do
  include PollUntil

  # A revoke removes the URL whichever realm made it — a frame's, revoked by its page (same origin) — and nothing in the
  # isolate resolves it after: not a fetch, not the driver's reads of it.
  it 'forgets a URL whichever realm revokes it' do
    page = '<!DOCTYPE html><meta charset=utf-8><iframe srcdoc="<script>parent.__made = URL.createObjectURL(new Blob([\'f\']))</script>"></iframe>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    url = s.evaluate_script('window.__made')
    expect(url).to start_with('blob:')
    expect(s.evaluate_script("__csimReadBlobBytes(#{url.to_json}) !== null")).to be(true)
    s.execute_script("URL.revokeObjectURL(#{url.to_json})")
    expect(s.evaluate_script("[__csimReadBlobBytes(#{url.to_json}), __csimReadBlobForWindow(#{url.to_json})]")).to eq([nil, nil])
  end

  # A new document in a realm revokes the URLs its last one made (File API's unloading document cleanup steps) — and
  # lets go of their blobs, which held the old document's context alive: twenty visits that each made one kept
  # twenty-one contexts.
  it "lets a visit revoke the last page's URLs, and its context go" do
    # (…a frame on the page, so each URL's bytes go to the host registry too: another realm may resolve them)
    page = '<!DOCTYPE html><meta charset=utf-8><iframe srcdoc="<p>f"></iframe>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    urls = Array.new(5) {
      s.visit '/'
      s.evaluate_script("URL.createObjectURL(new Blob(['x']))")
    }
    s.visit '/'
    expect(urls.map {|u| s.evaluate_script("[__csimReadBlobBytes(#{u.to_json}), __csimResolveBlobBytes(#{u.to_json})]") })
      .to all(eq([nil, nil]))
    ctx = s.driver.browser.instance_variable_get(:@runtime).instance_variable_get(:@ctx)
    ctx.low_memory_notification
    expect(ctx.heap_statistics[:number_of_native_contexts]).to eq(2)   # (…the page's and its frame's)
  end

  # A window opened at a blob URL another window made loads that window's blob whatever the fragment — the entry a URL
  # names is the one a fetch of it resolves to (blob_urls.rs `entry_key`), across windows as within one: `<url>#x` was
  # found in no window's partition and navigated to as a path on the opener's server.
  it 'opens another window\'s blob URL with a fragment' do
    app = lambda {|env|
      body = env['PATH_INFO'] == '/b' ? '<body>b<script>window.go = (s) => window.open(localStorage.u + s)</script>' : '<body>a'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script("localStorage.u = URL.createObjectURL(new Blob(['<!DOCTYPE html><meta charset=utf-8><title>made</title>'], {type: 'text/html'}))")
    b = s.window_opened_by { s.execute_script("window.open('/b')") }
    s.switch_to_window(b)
    opened = s.window_opened_by { s.execute_script("go('#x')") }
    s.switch_to_window(opened)
    expect(s.evaluate_script('[location.protocol, location.hash, document.title]')).to eq(['blob:', '#x', 'made'])
  end

  # A blob: link opened in a new window after its URL was revoked — before the click's activation could take its bytes —
  # loads nothing (a network error: Chrome shows the failed load at the URL), never the URL as a path on the app's server.
  it 'opens a revoked blob URL in a new window as a failed load' do
    paths = []
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><a id=l target=_blank>go</a>
      <script>
        const u = URL.createObjectURL(new Blob(['<p>x</p>'], {type: 'text/html'}));
        l.href = u;
        document.addEventListener('click', () => queueMicrotask(() => URL.revokeObjectURL(u)));
      </script>
    HTML
    s = simulated_session(->(env) { paths << env['PATH_INFO']; [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    href = s.evaluate_script('l.href')
    popup = s.window_opened_by { s.click_link 'go' }
    s.within_window(popup) do
      expect(s.current_url).to eq(href)
      expect(s.evaluate_script('document.body ? document.body.textContent : ""')).to eq('')
    end
    expect(paths).to eq(['/'])
  end

  # The window's own location set to a blob: URL loads its blob's document — and to one revoked, a failed load at the
  # URL — never sending the URL to the app's server (Rack took it for a path, and raised).
  it "navigates the window's own location to a blob URL, live or revoked" do
    paths = []
    page = '<!DOCTYPE html><meta charset=utf-8><p>start</p>'
    s = simulated_session(->(env) { paths << env['PATH_INFO']; [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    live = s.evaluate_script("URL.createObjectURL(new Blob(['<p id=b>blob</p>'], {type: 'text/html'}))")
    s.execute_script("location.href = #{live.to_json}")
    expect(s).to have_css('#b', text: 'blob')
    expect(s.current_url).to eq(live)
    s.visit '/'
    gone = s.evaluate_script("(() => { const u = URL.createObjectURL(new Blob(['x'])); URL.revokeObjectURL(u); return u; })()")
    s.execute_script("location.href = #{gone.to_json}")
    expect(s).to have_current_path(gone, url: true)
    expect(s.evaluate_script('document.body ? document.body.textContent : ""')).to eq('')
    expect(paths).to eq(['/', '/'])
  end

  # …its document an entry of the session history as any is: back leaves it, forward returns to its URL (Chrome; the
  # document there is the blob's where the URL still resolves — here the page that made it went with the back, revoking
  # it, where Chrome's back-forward cache keeps that page).
  it "keeps a blob URL's document in the session history" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><p id=h>home</p>']] })
    s.visit '/'
    u = s.evaluate_script("URL.createObjectURL(new Blob(['<p id=b>blob</p>'], {type: 'text/html'}))")
    s.execute_script("location.href = #{u.to_json}")
    expect(s).to have_css('#b')
    s.go_back
    expect(s).to have_css('#h')
    s.go_forward
    expect(s).to have_current_path(u, url: true)
  end

  # A redirect to a blob: URL is a network error (Fetch's HTTP-redirect fetch: a location URL of no HTTP(S) scheme),
  # never the blob's document.
  it 'takes a redirect to a blob URL for a network error' do
    s = simulated_session(lambda {|env|
      req = Rack::Request.new(env)
      next [302, {'location' => req.params['to']}, []] if req.path == '/r'
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><p>home</p>']]
    })
    s.visit '/'
    u = s.evaluate_script("URL.createObjectURL(new Blob(['<p id=b>from blob</p>'], {type: 'text/html'}))")
    s.execute_script("location.href = '/r?to=' + encodeURIComponent(#{u.to_json})")
    expect(s).to have_no_css('p', text: 'home')
    expect(s).to have_no_css('#b')
  end

  # A URL a worker made resolves in its page as the blob it is — its type with it, which the window's registry keeps
  # (it had resolved as `application/octet-stream`) — and one the page made is gone for the page once the worker revokes
  # it, whichever of the window's reads asks.
  it "resolves a worker's blob URL with its type, and a URL a worker revoked for none" do
    worker = <<~JS
      onmessage = (e) => {
        if (e.data === 'make') postMessage(URL.createObjectURL(new Blob(['w'], {type: 'text/plain'})));
        else { URL.revokeObjectURL(e.data); postMessage('revoked'); }
      };
    JS
    page = "<!DOCTYPE html><script>window.w = new Worker(URL.createObjectURL(new Blob([#{worker.to_json}], {type: 'text/javascript'})));</script>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      w.onmessage = async (e) => {
        const r = await fetch(e.data);
        window.got = [r.headers.get('content-type'), await r.text()];
      };
      w.postMessage('make');
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(['text/plain', 'w'])
    s.execute_script(<<~JS)
      window.mine = URL.createObjectURL(new Blob(['p']));
      window.revoked = false;
      w.onmessage = () => { window.revoked = true; };
      w.postMessage(mine);
    JS
    expect(poll_until { s.evaluate_script('window.revoked') }).to be(true)
    expect(s.evaluate_script('[__csimReadBlobBytes(mine), __csimReadBlobForWindow(mine)]')).to eq([nil, nil])
  end

  # A URL the page made before any worker existed — no other context to resolve it then, its entry only a marker — the
  # worker made after resolves, its bytes carried to the window's registry as the worker is spawned; and a window opened
  # at a URL a worker made loads that blob.
  it 'lets a later worker resolve an earlier URL, and a window open a worker-made one' do
    worker = <<~JS
      onmessage = async (e) => {
        if (e.data === 'make') return postMessage(URL.createObjectURL(new Blob(['<p id=w>made</p>'], {type: 'text/html'})));
        postMessage(await (await fetch(e.data)).text());
      };
    JS
    page = '<!DOCTYPE html><p>page'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.early = URL.createObjectURL(new Blob(['early']));
      window.w = new Worker(URL.createObjectURL(new Blob([#{worker.to_json}], {type: 'text/javascript'})));
      window.got = [];
      w.onmessage = (e) => got.push(e.data);
      w.postMessage(early);
      w.postMessage('make');
    JS
    expect(poll_until { r = s.evaluate_script('got'); r if r.size == 2 }.first).to eq('early')
    made = s.evaluate_script('got[1]')
    popup = s.window_opened_by { s.execute_script("open(#{made.to_json})") }
    s.within_window(popup) { expect(s).to have_css('#w', text: 'made') }
  end

  # The next page revokes the URLs every realm of the last one made — a frame's, a same-isolate popup's — as its own:
  # nothing of the new page resolves them.
  it "lets a visit revoke the URLs the last page's frames and popups made" do
    page = '<!DOCTYPE html><iframe srcdoc="<script>parent.fu = URL.createObjectURL(new Blob([\'FRAME\']))</script>"></iframe>' \
           "<script>window.pu = open().eval(\"URL.createObjectURL(new Blob(['POP']))\");</script>"
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/' ? page : '<p>b']] })
    s.visit '/'
    urls = s.evaluate_script('[fu, pu]')
    s.visit '/b'
    s.execute_script(<<~JS)
      window.got = null;
      Promise.all(#{urls.to_json}.map((u) => fetch(u).then(() => 'fetched', () => 'failed'))).then((r) => { window.got = r; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(%w[failed failed])
  end

  # Two Capybara sessions are two browsers: a page of one revoking a blob URL a page of the other made — the same origin,
  # the same site — revokes nothing there.
  it 'lets no other session revoke a blob URL' do
    app = ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] }
    one, two = simulated_session(app), simulated_session(app)
    one.visit '/'
    two.visit '/'
    url = one.evaluate_script("URL.createObjectURL(new Blob(['ONE']))")
    two.execute_script("URL.revokeObjectURL(#{url.to_json})")
    one.execute_script("window.got = null; fetch(#{url.to_json}).then((r) => r.text()).then((t) => { window.got = t; }, () => { window.got = 'failed'; });")
    expect(poll_until { one.evaluate_script('window.got') }).to eq('ONE')
  end

  # A navigation to a blob URL takes its blob as it begins (HTML resolves the URL's blob URL entry as it parses it): one
  # the page revokes straight after — its location set, a link of it clicked, a frame's `_top` link — still loads it.
  {
    'its location set'     => "location.href = u; URL.revokeObjectURL(u);",
    'a link of it clicked' => "const a = document.createElement('a'); a.href = u; document.body.append(a); a.click(); URL.revokeObjectURL(u);",
    "a frame's _top link"  => "const d = frames[0].document, a = d.createElement('a'); a.href = u; a.target = '_top'; d.body.append(a); a.click(); URL.revokeObjectURL(u);"
  }.each do |name, js|
    it "loads a blob a navigation began with however soon it is revoked: #{name}" do
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>TOP<iframe srcdoc="x"></iframe>']] })
      s.visit '/'
      s.execute_script("const u = URL.createObjectURL(new Blob(['<p>BLOB'], {type: 'text/html'})); #{js}")
      expect(poll_until { s.evaluate_script('document.body && document.body.textContent').then {|t| t if t == 'BLOB' } }).to eq('BLOB')
    end
  end

  # …and a user's click of a blob link, whose handler revokes it on a task of its own (Chrome: the blob's document).
  it 'loads the blob a clicked link began with, revoked by a task its click handler queued' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>TOP<a id=l>go</a>']] })
    s.visit '/'
    s.execute_script("const u = URL.createObjectURL(new Blob(['<p>BLOB'], {type: 'text/html'})); l.href = u; l.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(u), 0));")
    s.click_link 'go'
    expect(s.evaluate_script('document.body.textContent')).to eq('BLOB')
  end

  # A frame's own link to a blob URL navigates the frame to it — revoked straight after the click or not (Chrome).
  [false, true].each do |revoke|
    it "navigates a frame its own blob link targets#{' however soon it is revoked' if revoke}" do
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>TOP<iframe srcdoc="x"></iframe>']] })
      s.visit '/'
      s.within_frame(0) do
        s.execute_script("const u = URL.createObjectURL(new Blob(['<p>BLOB'], {type: 'text/html'})); const a = document.createElement('a'); a.href = u; document.body.append(a); a.click();#{' URL.revokeObjectURL(u);' if revoke}")
      end
      expect(poll_until { s.evaluate_script('frames[0].document.body && frames[0].document.body.textContent').then {|t| t if t == 'BLOB' } }).to eq('BLOB')
    end
  end

  # A redirect to a blob URL is a network error (Fetch's HTTP-redirect fetch: a location URL of no HTTP(S) scheme), an
  # entered frame's or another's; and a frame that went on from a blob document to another reloads that one, not the
  # blob it loaded before.
  it "loads no blob a frame's redirect names, and reloads the document a frame went on to" do
    url = nil
    s = simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/redir' then [302, {'location' => url}, []]
      when '/other' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>OTHER']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>TOP<iframe srcdoc="x"></iframe>']]
      end
    })
    s.visit '/'
    url = s.evaluate_script("URL.createObjectURL(new Blob(['<p>B'], {type: 'text/html'}))")
    s.within_frame(0) { s.execute_script("location.href = '/redir'") }
    s.evaluate_script('1')
    expect(s.evaluate_script('frames[0].document.body.textContent')).to eq('')
    s.execute_script("frames[0].location.href = #{url.to_json}")
    poll_until { s.evaluate_script('frames[0].document.body.textContent') == 'B' }
    s.execute_script("frames[0].location.href = 'http://www.example.com/other'")
    poll_until { s.evaluate_script('frames[0].document.body.textContent') == 'OTHER' }
    s.execute_script('frames[0].location.reload()')
    s.evaluate_script('1')
    expect(poll_until { s.evaluate_script('frames[0].location.href').then {|h| h if h.end_with?('/other') } }).to end_with('/other')
    expect(s.evaluate_script('frames[0].document.body.textContent')).to eq('OTHER')
  end

  # …its fragment aside: a srcdoc frame at `#z` reloads its srcdoc, and a frame at a revoked blob URL's `#y` the blob it
  # loaded — entered or not.
  it 'reloads the document a frame is at, its fragment aside' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>TOP<iframe srcdoc="<p>SD"></iframe>']] })
    s.visit '/'
    s.execute_script('frames[0].location.hash = "z"; frames[0].location.reload()')
    expect(poll_until { s.evaluate_script('frames[0].document.body && frames[0].document.body.textContent').then {|t| t if t == 'SD' } }).to eq('SD')
    s.execute_script("const w = frames[0], u = w.URL.createObjectURL(new w.Blob(['<p>BL'], {type: 'text/html'})); w.location.href = u; w.URL.revokeObjectURL(u);")
    poll_until { s.evaluate_script('frames[0].document.body.textContent') == 'BL' }
    s.execute_script('frames[0].location.hash = "y"; frames[0].location.reload()')
    s.evaluate_script('1')
    expect(s.evaluate_script('frames[0].document.body.textContent')).to eq('BL')
    s.within_frame(0) { s.execute_script('location.reload()') }
    expect(s.evaluate_script('frames[0].document.body.textContent')).to eq('BL')
  end
  # A URL is resolved by a context of its storage key alone (File API "obtain a blob object": every fetch of it but a
  # top-level navigation's) — a frame of another origin fetches and imports none of the page's (Chrome: each rejects), as
  # it revokes none — while a frame of its own origin does.
  it 'is resolved by a context of its origin alone' do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><script>
        window.url = URL.createObjectURL(new Blob(['export default 1'], {type: 'text/javascript'}));
      </script>
      <iframe src="http://other.test/f"></iframe><iframe src="/f"></iframe>
    HTML
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/f' ? '<!DOCTYPE html>f' : page]] })
    s.visit '/'
    url = s.evaluate_script('url')
    try = <<~JS
      window.got = [];
      fetch(#{url.to_json}).then(() => got.push('fetched'), () => got.push('fetch failed'));
      import(#{url.to_json}).then(() => got.push('imported'), () => got.push('import failed'));
    JS
    [0, 1].map {|i| s.within_frame(i) { s.execute_script(try) } }
    got = [0, 1].map {|i| s.within_frame(i) { poll_until { (g = s.evaluate_script('got')).size == 2 && g.sort } } }
    expect(got).to eq([['fetch failed', 'import failed'], %w[fetched imported]])
  end
  # …a frame's navigation no top-level one: a frame of another origin navigating itself to the page's URL loads none,
  # while the page navigating it there — its document the navigation's initiator — does; and a sandboxed frame, of an
  # opaque origin, fetches none of the page's (Chrome).
  it 'is resolved by the navigating document for a frame, and by no opaque origin' do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><script>
        window.url = URL.createObjectURL(new Blob(['<p>PAGEBLOB'], {type: 'text/html'}));
      </script>
      <iframe src="http://other.test/f"></iframe><iframe src="http://other.test/f"></iframe>
      <iframe sandbox="allow-scripts" srcdoc="<script>onmessage = (e) => fetch(e.data).then(() => window.got = 'fetched', () => window.got = 'failed')</script>"></iframe>
    HTML
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/f' ? '<!DOCTYPE html>f' : page]] })
    s.visit '/'
    url = s.evaluate_script('url')
    s.execute_script("frames[2].postMessage(#{url.to_json}, '*')")
    s.within_frame(0) { s.execute_script("location.href = #{url.to_json}") }
    s.execute_script("frames[1].location = #{url.to_json}")
    s.evaluate_script('1')
    texts = [0, 1].map {|i| s.within_frame(i) { s.evaluate_script('document.body ? document.body.textContent : ""') } }
    expect(texts).to eq(['', 'PAGEBLOB'])
    expect(s.within_frame(2) { poll_until { s.evaluate_script('window.got') } }).to eq('failed')
  end
end
