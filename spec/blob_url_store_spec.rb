# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The blob URL store is the isolate's (blob_urls.rs): one entry a URL, the realm that made it beside it.
RSpec.describe 'the blob URL store' do
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
end
