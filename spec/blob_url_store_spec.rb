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
end
