require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's document navigating itself (its `location`) navigates the container's navigable — HTML "navigate" — which
# writes none of the container's attributes: its `src` stays what the page set, whatever the URL's scheme.
RSpec.describe 'a nested document navigating itself' do
  include PollUntil

  def session
    pages = {
      '/'  => '<!DOCTYPE html><meta charset="utf-8"><body><iframe id=f src="/o"></iframe>',
      '/o' => '<!DOCTYPE html><meta charset="utf-8"><p>o'
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
    s.visit '/'
    s
  end

  it "keeps the container's src for a blob: URL, the bytes taken before the page revoked it" do
    s = session
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument?.body?.textContent') == 'o' }
    s.execute_script(<<~JS)
      const f = document.getElementById('f');
      window.R = [];
      new MutationObserver((records) => R.push(...records.map((r) => r.attributeName))).observe(f, {attributes: true});
      const w = f.contentWindow;
      const url = w.URL.createObjectURL(new w.Blob(['<p>b'], {type: 'text/html'}));
      w.location = url;
      w.URL.revokeObjectURL(url);
    JS
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument.body?.textContent') == 'b' }
    expect(s.evaluate_script('[document.getElementById("f").getAttribute("src"), R]')).to eq(['/o', []])
  end

  # …and a reload reloads the document it navigated to, not that `src`.
  it 'reloads the URL it navigated to' do
    s = session
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument?.body?.textContent') == 'o' }
    s.execute_script('document.getElementById("f").contentWindow.location = "about:blank"')
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument.URL') == 'about:blank' }
    s.execute_script('document.getElementById("f").contentWindow.location.reload()')
    sleep 0.2
    expect(poll_until { s.evaluate_script('document.getElementById("f").contentDocument.URL') }).to eq('about:blank')
  end

  # A frame's later navigation replaces the one it planned before (HTML "navigate"): `href = …` then `reload()` in one
  # task reloads the document the frame is at, and `reload()` then `href = …` goes to the URL (Chrome, measured: A, then
  # B, for the same two orders).
  it 'lets a later navigation of a frame replace the one it planned before' do
    hits = []
    pages = {'/' => '<!DOCTYPE html><meta charset="utf-8"><iframe id=f src="/a"></iframe>'}
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO']) { "<!DOCTYPE html><meta charset=\"utf-8\"><p>#{env['PATH_INFO']}" }]]
    })
    s.visit '/'
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/a' }
    hits.clear
    s.execute_script("const w = f.contentWindow; w.location.href = '/b'; w.location.reload();")
    poll_until { hits.include?('/a') }
    expect([hits, s.evaluate_script('f.contentDocument.body.textContent')]).to eq([['/a'], '/a'])
    hits.clear
    s.execute_script("const w = f.contentWindow; w.location.reload(); w.location.href = '/c';")
    poll_until { s.evaluate_script('f.contentDocument.body.textContent') == '/c' }
    expect(hits).to eq(['/c'])
  end

  # …and a frame's form submitted twice in one task submits what the later submission planned.
  it 'submits the later of two submissions a frame makes in one task' do
    hits = []
    pages = {
      '/'  => '<!DOCTYPE html><meta charset="utf-8"><iframe id=f src="/a"></iframe>',
      '/a' => '<!DOCTYPE html><meta charset="utf-8"><form id=fm action="/fs"><input name=q value=1></form>'
    }
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO'] + (env['QUERY_STRING'].empty? ? '' : "?#{env['QUERY_STRING']}")
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '<!DOCTYPE html><meta charset="utf-8"><p>done')]]
    })
    s.visit '/'
    poll_until { s.evaluate_script('f.contentDocument?.getElementById("fm") != null') }
    hits.clear
    s.execute_script("const d = f.contentDocument; d.getElementById('fm').submit(); d.querySelector('[name=q]').value = '2'; d.getElementById('fm').submit();")
    poll_until { hits.any? }
    expect(hits).to eq(['/fs?q=2'])
  end

  # A frame navigated away from has its whole tree unloaded before any of it is destroyed: an unload handler of one frame
  # still reaches its sibling's document, unloaded but not gone (Chrome, measured: the sibling `closed` false, its body
  # readable). (A removed frame's tree fires no unload at all: HTML "destroy a child navigable".)
  it "unloads a navigated frame's whole tree before destroying any of it" do
    leaf = '<!DOCTYPE html><meta charset=utf-8><body>leaf'
    g2 = '<!DOCTYPE html><meta charset=utf-8><script>onunload = () => { const s = parent.frames[0]; ' \
         'top.seen = [s.closed, s.document.body.textContent]; }</script>'
    c = %(<!DOCTYPE html><meta charset=utf-8><iframe srcdoc="#{leaf}"></iframe><iframe srcdoc="#{g2.gsub('"', '&quot;')}"></iframe>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<!DOCTYPE html><meta charset="utf-8"><iframe id=c srcdoc="#{c.gsub('&', '&amp;').gsub('"', '&quot;')}"></iframe>)]] })
    s.visit '/'
    poll_until { s.evaluate_script('c.contentWindow?.frames?.[1]?.document?.readyState') == 'complete' }
    s.execute_script("c.srcdoc = '<p>gone'")
    expect(poll_until { s.evaluate_script('top.seen') }).to eq([false, 'leaf'])
  end

  # A frame's `src` set records the session history entry of the URL it navigates to — parsed against its document's base
  # URL — so a traversal back and forward returns to that document.
  it "records a frame's navigation by its src parsed against the base URL" do
    hits = []
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><base href="/sub/"><iframe id=f src="/a"></iframe>']] if env['PATH_INFO'] == '/'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><p>#{env['PATH_INFO']}"]]
    })
    s.visit '/'
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/a' }
    s.execute_script("f.src = 'b'")
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/sub/b' }
    s.execute_script('f.contentWindow.history.back()')
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/a' }
    hits.clear
    s.execute_script('f.contentWindow.history.forward()')
    poll_until { hits.any? }
    expect(hits).to eq(['/sub/b'])
  end
end
