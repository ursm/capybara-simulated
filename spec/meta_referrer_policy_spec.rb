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
end
