require 'capybara/simulated'
require 'rack'

# Stylesheet handling the WPT Node-appendChild stylesheet/meta-from-fragment test
# exercises: `data:` URL CSS loaded into the cascade, alternate/preferred
# stylesheet SETS, `<meta http-equiv=default-style>` selecting a set, and
# HTMLMetaElement.httpEquiv reflection. getComputedStyle is backed by the cascade
# (not layout), so these are observable in-process.
RSpec.describe 'stylesheet sets + data: CSS' do
  def session_for(head_html)
    app = lambda do |_env|
      [200, {'content-type' => 'text/html'}, ["<!doctype html><html><head>#{head_html}</head><body>" \
        "<div id=a>a</div><div id=b>b</div></body></html>"]]
    end
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  def display(session, id) = session.evaluate_script("getComputedStyle(document.getElementById('#{id}')).display")
  def color(session, id)   = session.evaluate_script("getComputedStyle(document.getElementById('#{id}')).color")

  it 'loads percent-encoded data:text/css into the cascade' do
    s = session_for('<link rel=stylesheet href="data:text/css,%23a{display:none}">')
    expect(display(s, 'a')).to eq('none')
  end

  it 'loads base64 data:text/css into the cascade' do
    b64 = ['#a{display:none}'].pack('m0')   # base64, no newline
    s = session_for(%(<link rel=stylesheet href="data:text/css;base64,#{b64}">))
    expect(display(s, 'a')).to eq('none')
  end

  it 'ignores a non-CSS data: media type in a stylesheet link' do
    s = session_for('<link rel=stylesheet href="data:image/png,%23a{display:none}">')
    expect(display(s, 'a')).to eq('block')
  end

  it 'disables an alternate stylesheet by default' do
    s = session_for('<link rel="alternate stylesheet" title=alt href="data:text/css,%23a{display:none}">')
    expect(display(s, 'a')).to eq('block')
  end

  it 'enables an alternate stylesheet set via <meta http-equiv=default-style>' do
    s = session_for('<link rel="alternate stylesheet" title=alt href="data:text/css,%23a{display:none}">')
    expect(display(s, 'a')).to eq('block')
    s.execute_script("const m=document.createElement('meta');m.httpEquiv='default-style';m.content='alt';document.head.appendChild(m)")
    expect(display(s, 'a')).to eq('none')
  end

  it 'honors a static <meta http-equiv=default-style> selecting an alternate set' do
    s = session_for('<meta http-equiv=default-style content=alt>' \
                    '<link rel="alternate stylesheet" title=alt href="data:text/css,%23a{display:none}">')
    expect(display(s, 'a')).to eq('none')
  end

  it 'keeps a titleless persistent stylesheet always enabled' do
    s = session_for('<link rel=stylesheet href="data:text/css,%23a{display:none}">' \
                    '<link rel="alternate stylesheet" title=alt href="data:text/css,%23b{display:none}">')
    expect(display(s, 'a')).to eq('none')   # persistent, always on
    expect(display(s, 'b')).to eq('block')  # alternate, off by default
  end

  it 'reflects HTMLMetaElement.httpEquiv to the http-equiv attribute' do
    s = session_for('')
    s.execute_script("window.__m=document.createElement('meta');window.__m.httpEquiv='refresh'")
    expect(s.evaluate_script("window.__m.getAttribute('http-equiv')")).to eq('refresh')
    expect(s.evaluate_script("window.__m.httpEquiv")).to eq('refresh')
  end

  it 'enables the preferred set (first non-alternate titled sheet) and disables the others' do
    s = session_for('<style title=p>#a{display:none}</style><style title=q>#b{display:none}</style>')
    expect(display(s, 'a')).to eq('none')   # preferred set p
    expect(display(s, 'b')).to eq('block')  # set q not selected
  end

  it 'switches between titled sets via default-style, re-keying the cascade' do
    s = session_for('<style title=p>#a{display:none}</style><style title=q>#b{display:none}</style>')
    expect(display(s, 'a')).to eq('none')
    expect(display(s, 'b')).to eq('block')
    s.execute_script("const m=document.createElement('meta');m.httpEquiv='default-style';m.content='q';document.head.appendChild(m)")
    expect(display(s, 'a')).to eq('block')  # set p no longer selected
    expect(display(s, 'b')).to eq('none')   # set q now selected
  end

  it 'keeps distinct selected sets independent across visits (no cross-visit cache collision)' do
    # Two pages whose enabled sheets differ only by the selected set; the cascade
    # cache must key on the resolved set so one does not serve the other's rules.
    a = session_for('<meta http-equiv=default-style content=one>' \
                    '<style title=one>#a{display:none}</style><style title=two>#b{display:none}</style>')
    expect(display(a, 'a')).to eq('none')
    expect(display(a, 'b')).to eq('block')
    b = session_for('<meta http-equiv=default-style content=two>' \
                    '<style title=one>#a{display:none}</style><style title=two>#b{display:none}</style>')
    expect(display(b, 'a')).to eq('block')
    expect(display(b, 'b')).to eq('none')
  end

  it 'exposes base64 data: CSS rules through link.sheet (CSSOM)' do
    b64 = ['#a{color:red}'].pack('m0')
    s = session_for(%(<link id=l rel=stylesheet href="data:text/css;base64,#{b64}">))
    expect(s.evaluate_script("document.getElementById('l').sheet.cssRules.length")).to eq(1)
  end

  it 'applies the alternate set effect interleaved with fragment script insertion' do
    s = session_for('<link rel="alternate stylesheet" title=alternative href="data:text/css,%23a{display:none}">')
    r = s.evaluate_script(<<~JS)
      (function () {
        const a = document.getElementById('a');
        window.__pre = null; window.__post = null;
        const pre  = document.createElement('script');
        pre.textContent  = 'window.__pre = getComputedStyle(document.getElementById("a")).display';
        const meta = document.createElement('meta');
        meta.httpEquiv = 'default-style'; meta.content = 'alternative';
        const post = document.createElement('script');
        post.textContent = 'window.__post = getComputedStyle(document.getElementById("a")).display';
        const df = document.createDocumentFragment();
        df.append(pre, meta, post);
        document.head.appendChild(df);
        return JSON.stringify({ pre: window.__pre, post: window.__post, after: getComputedStyle(a).display });
      })()
    JS
    expect(JSON.parse(r)).to eq('pre' => 'block', 'post' => 'none', 'after' => 'none')
  end
end
