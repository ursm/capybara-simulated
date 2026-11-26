require 'capybara/simulated'
require_relative 'support/session_teardown'

# The focus update steps as the engine runs them (focus_update.rs): what moves the focus, what blurs and focuses on the
# way, and when. Each figure Chrome's (2026-11-27) unless said otherwise.
RSpec.describe 'Focus update steps' do
  let(:frame) { '<!DOCTYPE html><meta charset="utf-8"><input id="x"><button id="y">y</button>' }
  let(:page) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <script>var log = []; function L(s) { log.push(s); }</script>
      <input id="a"><button id="b">b</button><fieldset id="fs"><input id="c"></fieldset>
      <a id="lnk" href="#t">to t</a><button id="before">before</button><div id="t">t</div><button id="after">after</button>
      <iframe id="fr" src="/frame"></iframe>
      <script>
        for (const id of ['a', 'b', 'c']) for (const t of ['focus', 'blur']) document.getElementById(id).addEventListener(t, () => L(id + ':' + t));
        window.addEventListener('blur', (e) => { if (e.target === window) L('win:blur'); });
      </script>
    HTML
  }
  let(:session) {
    pages = {'/frame' => frame, '/' => page}
    simulated_session(->(env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [pages.fetch(env['PATH_INFO'], '')]] })
  }

  before { session.visit '/' }

  def raf(session)
    session.evaluate_async_script('const done = arguments[0]; requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0)))')
  end

  # HTML runs the focus fixup in "update the rendering" — "It might also happen to an input element when the element gets
  # disabled" — and so does Chrome for an input's own `disabled`: the element stays the active one until then.
  it 'blurs a control disabled under the focus at the rendering update' do
    expect(session.evaluate_script("a.focus(); log.length = 0; a.disabled = true; [document.activeElement.id, log.join()]")).to eq(['a', ''])
    raf(session)
    expect(session.evaluate_script('[document.activeElement.tagName, log.join()]')).to eq(%w[BODY a:blur])
  end

  # …a document the focus is not in has its focused area replaced silently: no event, the focus staying where it is.
  it "designates a frame document's viewport silently where the focus is elsewhere" do
    session.execute_script("fr.contentDocument.getElementById('x').focus(); a.focus(); log.length = 0; fr.contentDocument.getElementById('x').hidden = true")
    raf(session)
    expect(session.evaluate_script("[document.activeElement.id, fr.contentDocument.activeElement.tagName, log.join()]")).to eq(['a', 'BODY', ''])
  end

  # `window.focus()` of a window whose document holds the focus — in a frame of it — moves nothing.
  it 'keeps the focus in a frame as the page calls window.focus()' do
    session.execute_script("fr.contentDocument.getElementById('x').focus(); log.length = 0; window.focus()")
    expect(session.evaluate_script("[document.activeElement.id, fr.contentDocument.activeElement.id, fr.contentDocument.hasFocus(), log.join()]")).to eq(['fr', 'x', true, ''])
  end

  # The user's keyboard shows the ring of what a click focused (Selectors 4: "If the user interacts with the page via
  # keyboard, the currently focused element should match :focus-visible").
  it 'shows the focus ring of a clicked button once a key is pressed' do
    session.click_button('b')
    expect(session.evaluate_script("b.matches(':focus-visible')")).to be(false)
    session.find(:css, '#b').send_keys(:shift)
    expect(session.evaluate_script("b.matches(':focus-visible')")).to be(true)
  end

  # A text control focused puts its document's selection before it (Firefox likewise since bug 2032191).
  it "moves the document's selection before a text control focused" do
    expect(session.evaluate_script("getSelection().collapse(document.body, 0); a.focus(); const r = getSelection().getRangeAt(0); [r.startContainer.nodeName, r.startOffset === [...document.body.childNodes].indexOf(a), r.collapsed]")).to eq(['BODY', true, true])
  end

  # Tab past the last stop of the page — in its frame — leaves it, and the next Tab comes back in at its start (HTML
  # step 7: "unset the sequential focus navigation starting point").
  it 'comes back in at the start after Tab leaves the page from a frame' do
    session.execute_script("fr.contentDocument.getElementById('y').focus()")
    session.find(:css, 'body').send_keys(:tab)
    expect(session.evaluate_script('document.hasFocus()')).to be(false)
    session.find(:css, 'body').send_keys(:tab)
    expect(session.evaluate_script('[document.activeElement.id, document.hasFocus()]')).to eq(['a', true])
  end

  # The starting point stays where the focused element was as it is removed: Tab goes on to what came after it, Shift+Tab
  # to what came before (Chrome and Firefox; WPT sequential-focus-navigation-starting-point).
  it 'goes on from where a focused element was removed' do
    session.execute_script('b.focus(); b.remove()')
    session.find(:css, 'body').send_keys(:tab)
    expect(session.evaluate_script('document.activeElement.id')).to eq('c')
    session.execute_script('c.focus(); c.remove()')
    session.find(:css, 'body').send_keys(%i[shift tab])
    expect(session.evaluate_script('document.activeElement.id')).to eq('a')
  end

  # HTML "scroll to the fragment": "Run the focusing steps for target, with the Document's viewport as the fallback
  # target. Move the sequential focus navigation starting point to target." — the link loses the focus, and Tab goes on
  # from the target.
  it 'moves the focus and the starting point to the target of a fragment navigation' do
    session.click_link('to t')
    expect(session.evaluate_script('[location.hash, document.activeElement.tagName]')).to eq(['#t', 'BODY'])
    session.find(:css, 'body').send_keys(:tab)
    expect(session.evaluate_script('document.activeElement.id')).to eq('after')
  end
end
