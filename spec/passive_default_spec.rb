require 'capybara/simulated'
require_relative 'support/session_teardown'

# DOM "default passive value": a wheel / touch listener added with no `passive` option is passive on the Window, a
# Document and its document's document element or body element — not on any element named body. Chrome 155: a
# detached `<body>`'s listener cancels the event (true), the document's body's and root's do not (false), a div's does.
RSpec.describe 'the default passive value' do
  it "is passive only on the window, the document, its root and its body" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = (el) => {
          el.addEventListener('wheel', (e) => e.preventDefault());
          const ev = new WheelEvent('wheel', {cancelable: true});
          el.dispatchEvent(ev);
          return ev.defaultPrevented;
        };
        return [t(document.createElement('body')), t(document.body), t(document.documentElement), t(document.createElement('div'))];
      })()
    JS
    expect(got).to eq([true, false, false, true])
  end
end
