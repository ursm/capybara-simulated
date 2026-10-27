# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element adopted from the page into a frame is the frame's — its tree's realm — however the page's code writes it:
# a checkedness its page-made setter writes, revealing what `:checked` shows, asks a rendering update's observations of
# the FRAME (mutation_observers.rs `note_observations`), whose IntersectionObserver hears of it; so does a radio it
# checks that unchecks the frame's.
RSpec.describe "a frame's observations of an element another realm's code writes" do
  frame = <<~HTML
    <!DOCTYPE html><meta charset="utf-8">
    <style>.rev { display: none; height: 20px } input:checked + .rev { display: block }</style>
    <div id=host></div><div class=rev id=t>T</div><p id=log>none</p>
    <script>
      new IntersectionObserver((es) => {
        for (const e of es) if (e.isIntersecting) document.getElementById('log').textContent = 'SEEN';
      }).observe(document.getElementById('t'));
    </script>
  HTML

  let(:session) {
    app = lambda {|env|
      html = env['PATH_INFO'] == '/frame' ? frame : '<!DOCTYPE html><meta charset="utf-8"><iframe id=fr src=/frame></iframe>'
      [200, {'content-type' => 'text/html'}, [html]]
    }
    simulated_session(app).tap {|s|
      s.visit '/'
      s.within_frame('fr') { s.find('#log', text: 'none') }
    }
  }

  it 'reveals an observed target by a checkbox the page made and checked' do
    session.execute_script(<<~JS)
      const i = document.createElement('input'); i.type = 'checkbox'; window.__i = i;
      document.getElementById('fr').contentDocument.getElementById('t').before(i);
    JS
    session.within_frame('fr') { session.has_text?('none', wait: 0) }
    session.execute_script('window.__i.checked = true')
    expect(session.within_frame('fr') { session.has_text?('SEEN', wait: 0.5) }).to be(true)
  end

  it "reveals an observed target by the frame's radio a page-made one unchecks" do
    session.within_frame('fr') {
      session.execute_script("document.getElementById('host').innerHTML = '<input type=radio name=g checked><div class=rev2 id=t2>T2</div>'")
    }
    session.execute_script(<<~JS)
      const d = document.getElementById('fr').contentDocument;
      const st = d.createElement('style'); st.textContent = '.rev2 { height: 20px } input:checked + .rev2 { display: none }';
      d.head.append(st);
      const r = document.createElement('input'); r.type = 'radio'; r.name = 'g'; window.__r = r;
      d.getElementById('host').append(r);
      new d.defaultView.IntersectionObserver((es) => {
        for (const e of es) if (e.isIntersecting) d.getElementById('log').textContent = 'SEEN2';
      }).observe(d.getElementById('t2'));
    JS
    session.within_frame('fr') { session.has_text?('none', wait: 0.2) }
    session.execute_script('window.__r.checked = true')
    expect(session.within_frame('fr') { session.has_text?('SEEN2', wait: 0.5) }).to be(true)
  end
end
