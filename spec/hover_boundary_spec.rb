# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# UI Events' boundary events as the pointer moves (event_path.rs `hover_chains`): mouseleave on each element left,
# innermost first, mouseenter on each entered, outermost first, up to the element both share — the flat tree's
# ancestors, a slotted element's next its slot, a shadow tree's top its host, never the shadow root. Every expectation
# is Chrome's (a real pointer moved over the same boxes).
RSpec.describe 'pointer boundary events' do
  it 'leaves and enters along the flat tree' do
    html = <<~HTML
      <!DOCTYPE html><body style="margin:0"><div id=out style="height:40px">out</div><div id=host><span id=light style="display:block;height:40px">light</span></div>
      <script>
        const host = document.getElementById('host'); const sr = host.attachShadow({mode: 'open'});
        sr.innerHTML = '<div id=wrap><slot id=sl></slot></div><div id=inner style="height:40px">inner</div>';
        window.log = [];
        const name = (n) => n === sr ? '#shadow-root' : (n.id || n.nodeName);
        for (const n of [document.getElementById('out'), host, document.getElementById('light'), sr, sr.getElementById('wrap'), sr.getElementById('sl'), sr.getElementById('inner'), document.body, document.documentElement])
          for (const t of ['mouseenter', 'mouseleave']) n.addEventListener(t, () => log.push(t + ':' + name(n)));
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    moves = [
      -> { s.find(:css, '#out').hover },
      -> { s.find(:css, '#light').hover },
      -> { s.find(:css, '#host').shadow_root.find(:css, '#inner').hover },
      -> { s.find(:css, '#out').hover }
    ]
    logs = moves.map {|move|
      s.execute_script('window.log = []')
      move.call
      s.evaluate_script('window.log')
    }
    expect(logs.drop(1)).to eq([
      %w[mouseleave:out mouseenter:host mouseenter:wrap mouseenter:sl mouseenter:light],
      %w[mouseleave:light mouseleave:sl mouseleave:wrap mouseenter:inner],
      %w[mouseleave:inner mouseleave:host mouseenter:out]
    ])
  end
end
