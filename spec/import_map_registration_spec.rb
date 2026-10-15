require 'capybara/simulated'
require_relative 'support/session_teardown'

# An import map is registered when its `<script type="importmap">` is prepared (HTML "prepare the script element",
# script.rs `prepare_script`): by the parser at its end tag, or on insertion — and one with a `src` fires `error`, there
# being no external import maps. Text that is no import map is reported: a SyntaxError for no JSON, a TypeError for no
# map. Chrome 155, measured: `onerror` sees SyntaxError, TypeError, TypeError for `{`, `[1]` and a scope that is an
# array, an inserted map resolves a bare `import('m')`, and `<script type=importmap src>` fires `error` without a fetch.
RSpec.describe 'import map registration' do
  let(:session) {
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.log = [];
        onerror = (m, f, l, c, e) => { log.push('onerror ' + (e && e.constructor.name)); };
      </script>
      <script type="importmap">{</script><script type="importmap">[1]</script>
      <script type="importmap">{"scopes": {"/a/": []}}</script>
      <script type="importmap" src="/map.json" onload="log.push('external load')" onerror="log.push('external error')"></script>
    HTML
    fetched = []
    s = simulated_session(->(env) {
      fetched << env['PATH_INFO']
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, [page]]
      when '/m.js' then [200, {'content-type' => 'text/javascript'}, ['export default 42']]
      else [200, {'content-type' => 'application/importmap+json'}, ['{"imports": {"x": "/m.js"}}']]
      end
    })
    s.visit '/'
    s.define_singleton_method(:fetched) { fetched }
    s
  }

  it 'reports text that is no import map, and fires error for an external one without fetching it' do
    expect(session.evaluate_async_script('setTimeout(() => arguments[0](log), 10)')).to eq(
      ['onerror SyntaxError', 'onerror TypeError', 'onerror TypeError', 'external error']
    )
    expect(session.fetched).not_to include('/map.json')
  end

  it 'registers a map inserted by a script' do
    got = session.evaluate_async_script(<<~JS)
      const s = document.createElement('script');
      s.type = 'importmap';
      s.textContent = '{"imports": {"m": "/m.js"}}';
      document.head.append(s);
      import('m').then(m => arguments[0](m.default), e => arguments[0](String(e)));
    JS
    expect(got).to eq(42)
  end

  # The XML parser prepares no script at its end tag here: the after-parse pass registers its import maps in tree order
  # with its parser-blocking scripts, before the scripts after them run.
  it "registers an XML document's map before its later scripts run" do
    page = <<~XHTML
      <html xmlns="http://www.w3.org/1999/xhtml"><head>
      <script type="importmap">{"imports": {"x": "/m.js"}}</script>
      <script>window.got = import('x').then(m => m.default, e => String(e));</script>
      </head><body/></html>
    XHTML
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/javascript'}, ['export default 7']] if env['PATH_INFO'] == '/m.js'
      [200, {'content-type' => 'application/xhtml+xml'}, [page]]
    })
    s.visit '/'
    expect(s.evaluate_async_script('got.then(arguments[0])')).to eq(7)
  end
end
