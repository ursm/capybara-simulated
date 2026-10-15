require 'capybara/simulated'
require_relative 'support/session_teardown'

# The pointer coming onto an element (UI Events): pointerover, pointerenter, mouseover, mouseenter — the element it came
# from their relatedTarget — then pointermove and mousemove, whose relatedTarget is null; hovering it again moves it
# alone. A click moves the pointer onto its target first — its enter events included where it comes onto it, its moves
# each time — as a WebDriver click does (Chrome 155, Playwright: a second click on #b fires pointermove and mousemove
# before its pointerdown).
RSpec.describe 'hover events' do
  let(:session) {
    simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><div id="a">a</div><div id="b">b</div>
        <script>
          window.seen = [];
          for (const id of ['a', 'b']) {
            for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
              document.getElementById(id).addEventListener(type, (e) => {
                if (e.target === e.currentTarget) seen.push(id + ' ' + type + ' ' + (e.relatedTarget ? e.relatedTarget.id : null));
              });
            }
          }
        </script>
      HTML
    }).tap {|s| s.visit '/' }
  }

  it 'fires over and enter where the pointer comes onto an element, and moves with no relatedTarget' do
    session.find('#a').hover
    session.find('#a').hover
    session.find('#b').click
    session.find('#b').click
    expect(session.evaluate_script('seen')).to eq([
      'a pointerover null', 'a pointerenter null', 'a mouseover null', 'a mouseenter null', 'a pointermove null', 'a mousemove null',
      'a pointermove null', 'a mousemove null',
      'b pointerover a', 'b pointerenter a', 'b mouseover a', 'b mouseenter a', 'b pointermove null', 'b mousemove null',
      'b pointermove null', 'b mousemove null'
    ])
  end

  # Leaving one element for another, the pointer's boundary events come first — out on the element left, leave on each
  # one left (innermost first), over on the one entered, enter on each one entered — then their compatibility mouse
  # events in the same order (Pointer Events; Chrome 155, Playwright's mouse moved from #ai to #b).
  it 'fires the pointer boundary events before the mouse ones' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><body style="margin:0"><div id="a" style="width:100px;height:100px">
        <span id="ai" style="display:block;width:50px;height:50px"></span></div><div id="b" style="width:100px;height:100px"></div>
        <script>
          window.L = [];
          for (const id of ['a', 'ai', 'b']) {
            for (const t of ['pointerover', 'pointerenter', 'pointerout', 'pointerleave', 'mouseover', 'mouseenter', 'mouseout', 'mouseleave']) {
              document.getElementById(id).addEventListener(t, (e) => { if (e.target.id === id) L.push(`${id}:${t}`); });
            }
          }
        </script>
      HTML
    })
    s.visit '/'
    s.find('#ai').hover
    s.execute_script('L.length = 0')
    s.find('#b').hover
    expect(s.evaluate_script('L')).to eq(%w[
      ai:pointerout ai:pointerleave a:pointerleave b:pointerover b:pointerenter
      ai:mouseout ai:mouseleave a:mouseleave b:mouseover b:mouseenter
    ])
  end
end
