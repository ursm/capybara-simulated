require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's `<meta name="referrer">` (url_ops.rs `meta_referrer_policy`): its content ASCII-lowercased, a legacy
# keyword mapped (`never` → no-referrer), the last valid one in tree order — what a frame's navigation of itself (a link
# followed in it) sends its Referer by.
RSpec.describe 'the meta referrer policy' do
  it "sets a frame's navigation Referer by its last valid meta" do
    referers = {}
    s = simulated_session(->(env) {
      referers[env['PATH_INFO']] = env['HTTP_REFERER']
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe src="/frame"></iframe>']]
      when '/frame'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><meta name="Referrer" content="bogus"><meta name="REFERRER" content="NEVER">
          <a id="go" href="/next">go</a>
        HTML
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id="done">next</p>']]
      end
    })
    s.visit '/'
    s.within_frame(0) do
      s.click_link 'go'
      expect(s).to have_css('#done')
    end
    expect(referers['/next']).to be_nil
  end

  # …and a page's own: a link followed on the top-level page sends none under `no-referrer`, its origin alone under
  # `origin`; a driver's visit sends none whatever the policy.
  it "sets a page's navigation Referer by its policy" do
    referers = []
    policy = 'no-referrer'
    s = simulated_session(->(env) {
      referers << [env['PATH_INFO'], env['HTTP_REFERER']]
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id="done">next</p>']] if env['PATH_INFO'] == '/next'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"#{policy}\"><a href=\"/next\">go</a>"]]
    })
    s.visit '/a'
    s.click_link 'go'
    policy = 'origin'
    s.visit '/b'
    s.click_link 'go'
    expect(referers).to eq([['/a', nil], ['/next', nil], ['/b', nil], ['/next', 'http://www.example.com/']])
  end

  # The policy holds on every redirect hop (Fetch determines the referrer anew per hop), a driver's visit sends none on
  # any hop, and a form posting to a new window sends its own document's under its own policy.
  it 'holds through redirects and into a new window' do
    referers = []
    s = simulated_session(->(env) {
      referers << [env['PATH_INFO'], env['HTTP_REFERER']]
      case env['PATH_INFO']
      when '/r' then [302, {'location' => '/next'}, []]
      when '/next', '/pb' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p>next</p>']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><a href="/r">go</a>
          <form method="post" action="/pb" target="_blank"><button>post</button></form>
        HTML
      end
    })
    s.visit '/a'
    s.click_link 'go'
    s.visit '/a'
    s.click_button 'post'
    s.visit '/r'
    expect(referers).to eq([['/a', nil], ['/r', nil], ['/next', nil], ['/a', nil], ['/pb', nil], ['/r', nil], ['/next', nil]])
  end

  # An iframe srcdoc document refers as its container document does, under the policy it inherits from it: a link in one
  # sends the container's URL, whether it navigates the frame or the page.
  it "sends an iframe srcdoc document's container as its Referer" do
    referers = []
    s = simulated_session(->(env) {
      referers << [env['PATH_INFO'], env['HTTP_REFERER']]
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id="done">next</p>']] unless env['PATH_INFO'] == '/a'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><meta name="referrer" content="origin">
        <iframe srcdoc="<a href='/self'>self</a> <a href='/top' target='_top'>top</a>"></iframe>
      HTML
    })
    s.visit '/a'
    s.within_frame(0) do
      s.click_link 'self'
      expect(s).to have_css('#done')
    end
    s.visit '/a'
    s.within_frame(0) { s.click_link 'top' }
    expect(s).to have_css('#done')
    expect(referers).to eq([['/a', nil], ['/self', 'http://www.example.com/'], ['/a', nil], ['/top', 'http://www.example.com/']])
  end

  # …but a sandboxed one's origin is opaque, and an opaque origin refers as none — a step before the container.
  it 'sends no Referer from a sandboxed srcdoc document' do
    referers = []
    s = simulated_session(->(env) {
      referers << [env['PATH_INFO'], env['HTTP_REFERER']]
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id="done">next</p>']] unless env['PATH_INFO'] == '/a'
      [200, {'content-type' => 'text/html'}, [%(<!DOCTYPE html><meta charset="utf-8"><iframe sandbox="allow-forms" srcdoc="<a href='/self'>self</a> <form method=post action='/post'><button>post</button></form>"></iframe>)]]
    })
    s.visit '/a'
    s.within_frame(0) do
      s.click_link 'self'
      expect(s).to have_css('#done')
    end
    s.visit '/a'
    s.within_frame(0) do
      s.click_button 'post'
      expect(s).to have_css('#done')
    end
    expect(referers).to eq([['/a', nil], ['/self', nil], ['/a', nil], ['/post', nil]])
  end

  # …and a fetch's or an XHR's whose request sets none: Fetch's "main fetch" gives it the policy container's — a
  # `same-origin` page's cross-origin request sends no Referer, and a POST of it `Origin: null`; a same-origin one, the
  # page's URL.
  it "sets a page's fetch and XHR Referer by its policy where the request sets none" do
    seen = []
    s = simulated_session(->(env) {
      seen << [env['PATH_INFO'], env['HTTP_REFERER'], env['HTTP_ORIGIN']] if env['PATH_INFO'].start_with?('/r')
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><meta name="referrer" content="same-origin"><p>x']]
    })
    s.visit '/p'
    s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const xhr = (url) => new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', url); x.onloadend = resolve; x.send(); });
      fetch('http://other.example.com/r1', {method: 'POST', mode: 'no-cors', body: 'x'})
        .then(() => fetch('/r2'))
        .then(() => xhr('http://other.example.com/r3'))
        .then(() => xhr('/r4'))
        .then(() => done(1), () => done(0));
    JS
    expect(seen).to eq([
      ['/r1', nil, 'null'],
      ['/r2', 'http://www.example.com/p', nil],
      ['/r3', nil, 'http://www.example.com'],
      ['/r4', 'http://www.example.com/p', nil]
    ])
  end

  # …which a meta sets as it is connected — after a script connected before it in the same batch — or as its `content`
  # changes, a removal undoing none of it, a prepended one winning as the last to run (HTML §4.2.5.3; Chrome, each).
  it 'is what the meta last connected or changed set, whatever the tree order' do
    referers = []
    s = simulated_session(->(env) {
      referers << [env['PATH_INFO'], env['HTTP_REFERER']] if env['PATH_INFO'].start_with?('/n/')
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p>x']]
    })
    s.visit '/p'
    s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const get = (path) => { const x = new XMLHttpRequest(); x.open('GET', path, false); x.send(); };
      const meta = (content) => Object.assign(document.createElement('meta'), {name: 'referrer', content});
      window.get = get;
      const box = document.createElement('div');
      const s1 = document.createElement('script');
      s1.textContent = "get('/n/pre')";
      const s2 = document.createElement('script');
      s2.textContent = "get('/n/post')";
      const m = meta('no-referrer');
      box.append(s1, m, s2);
      document.body.append(box);
      m.remove();
      get('/n/removed');
      document.head.append(meta('origin'));
      const u = meta('unsafe-url');
      document.head.prepend(u);
      get('/n/prepended');
      u.content = 'bogus';
      get('/n/bogus');
      u.content = 'no-referrer';
      get('/n/changed');
      done(1);
    JS
    expect(referers).to eq([
      ['/n/pre', 'http://www.example.com/p'],
      ['/n/post', nil],
      ['/n/removed', nil],
      ['/n/prepended', 'http://www.example.com/p'],
      ['/n/bogus', 'http://www.example.com/p'],
      ['/n/changed', nil]
    ])
  end
end
