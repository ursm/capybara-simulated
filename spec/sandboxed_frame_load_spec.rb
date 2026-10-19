require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame of the host a document was served from loads with it, as a browser's does, though the document is sandboxed
# — its origin an opaque one, which no URL's is: a script the frame runs as it loads, posting its parent, is heard
# without the parent ever reading `contentWindow` (Chrome: "from null" at once).
RSpec.describe 'a frame of a sandboxed document' do
  it 'loads with its document and posts it as it does' do
    child = '<!doctype html><meta charset="utf-8"><script>parent.postMessage("from " + self.origin, "*");</script>'
    page  = <<~HTML
      <!doctype html><meta charset="utf-8"><script>window.got = []; addEventListener("message", (e) => got.push(e.data));</script>
      <iframe src="/child"></iframe>
    HTML
    app = lambda {|env|
      next [200, {'content-type' => 'text/html'}, [child]] if env['PATH_INFO'] == '/child'

      [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts'}, [page]]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(got), 100)')).to eq(['from null'])
  end
end
