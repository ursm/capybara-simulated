# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A click's activation is DOM dispatch's (dom-nodes.js `activationBehavior`), whichever way the click came: a checkbox
# toggled as its click is dispatched — not before the press — and a label's labeled control focused and clicked, the
# user's click carried over, with no press of its own. Every expectation is Chrome's (a real pointer clicking the same
# boxes).
RSpec.describe 'click activation' do
  let(:html) {
    <<~HTML
      <!DOCTYPE html><body style="margin:0"><label id=l for=c style="display:block;height:30px">L</label>
      <input type=checkbox id=c style="display:block;width:30px;height:30px">
      <input type=checkbox id=c2 style="display:block;width:30px;height:30px" onclick="return false">
      <script>
        window.log = [];
        const c = document.getElementById('c');
        for (const id of ['l', 'c', 'c2']) {
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focus', 'input', 'change']) {
            document.getElementById(id).addEventListener(type, (e) => {
              log.push([id, type, type === 'click' ? [e.isTrusted, e.detail, e.pointerType].join() : '', c.checked].join(':'));
            });
          }
        }
      </script>
    HTML
  }

  def clicks(session, *ids)
    ids.map {|id|
      session.find(:css, "##{id}").click
      [session.evaluate_script('window.log.splice(0)'), session.evaluate_script('document.activeElement.id')]
    }
  end

  it 'toggles a checkbox as its click is dispatched, and clicks a label through to its control' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    label, box, canceled = clicks(s, 'l', 'c', 'c2')
    expect(label).to eq([
      %w[
        l:pointerdown::false l:mousedown::false l:pointerup::false l:mouseup::false l:click:true,1,mouse:false
        c:focus::false c:click:true,1,mouse:true c:input::true c:change::true
      ],
      'c'
    ])
    expect(box).to eq([
      %w[
        c:pointerdown::true c:mousedown::true c:pointerup::true c:mouseup::true c:click:true,1,mouse:false
        c:input::false c:change::false
      ],
      'c'
    ])
    expect(canceled).to eq([
      %w[
        c2:pointerdown::false c2:mousedown::false c2:focus::false c2:pointerup::false c2:mouseup::false
        c2:click:true,1,mouse:false
      ],
      'c2'
    ])
    expect(s.evaluate_script('document.getElementById("c2").checked')).to be(false)
  end
end
