require 'capybara/simulated'
require_relative 'support/session_teardown'

# The focus a dialog takes as it opens and gives back as it closes (HTML "dialog focusing steps", "close the dialog"):
# show() and showModal() focus the dialog where it carries `autofocus`, else its focus delegate — its first `autofocus`
# descendant that can take focus, else its first that can — else the dialog itself, which Chrome and Firefox both let
# take focus (`focus()` too) while it is rendered; closing it focuses the element focused before it opened, where it
# was modal or held focus. Every figure Firefox's (2026-10-10); Chrome's too, but for a dialog carrying `autofocus`,
# where Chrome focuses its first focusable descendant instead — the spec, and Firefox, focus the dialog. Out of the
# sequential order, as Chrome keeps it (`tabIndex` -1; Firefox's 0).
RSpec.describe 'Dialog focus' do
  let(:html) {
    <<~HTML
      <!doctype html><meta charset=utf-8><body>
      <input id=behind><dialog id=d1><p>none</p></dialog><dialog id=d2><input id=i2><button id=b2 autofocus>x</button></dialog>
      <dialog id=d3 autofocus><input id=i3></dialog><dialog id=d4><input id=i4></dialog>
    HTML
  }
  let(:session) { simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] }) }

  it 'focuses what the dialog focusing steps pick, and gives focus back on close' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = [], a = () => document.activeElement.id || document.activeElement.tagName;
        behind.focus(); d1.showModal(); r.push('d1 ' + a()); d1.close(); r.push('d1close ' + a());
        behind.focus(); d2.showModal(); r.push('d2 ' + a()); d2.close(); r.push('d2close ' + a());
        behind.focus(); d3.showModal(); r.push('d3 ' + a()); d3.close(); r.push('d3close ' + a());
        behind.focus(); d4.show(); r.push('d4show ' + a()); d4.close(); r.push('d4close ' + a());
        behind.focus(); d1.show(); d1.blur(); d1.focus(); r.push('refocus ' + a()); d1.close();
        r.push('tabIndex ' + d1.tabIndex);
        return r;
      })()
    JS
    expect(got).to eq(['d1 d1', 'd1close behind', 'd2 b2', 'd2close behind', 'd3 d3', 'd3close behind', 'd4show i4', 'd4close behind', 'refocus d1', 'tabIndex -1'])
  end

  it 'loses focus to keys sent to the document element, as WebDriver focuses the viewport' do
    session.visit '/'
    session.execute_script('document.addEventListener("keydown", (e) => window.k = e.target.tagName); d4.show()')
    session.find('html').send_keys('x')
    expect(session.evaluate_script('[document.activeElement.tagName, window.k, i4.value]')).to eq(['BODY', 'BODY', ''])
  end

  it 'goes on from where focus was, or where a press landed, when nothing is focused' do
    session.visit '/'
    session.execute_script('i4.remove(); d1.remove(); d2.remove(); d3.remove(); d4.insertAdjacentHTML("afterend", "<p id=t>text</p><button id=b>b</button><button id=c>c</button>")')
    session.execute_script('c.focus()')
    session.find('#t').click
    session.find('html').send_keys(:tab)
    expect(session.evaluate_script('document.activeElement.id')).to eq('b')
    session.execute_script('behind.focus(); behind.blur()')
    session.find('html').send_keys(:tab)
    expect(session.evaluate_script('document.activeElement.id')).to eq('b')
  end
end
