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

  def page_session(pages)
    app = lambda {|env|
      body = pages[env['PATH_INFO']] || "<p id=echo>#{env['PATH_INFO']}?#{env['QUERY_STRING']}</p>"
      [200, {'content-type' => 'text/html; charset=utf-8'}, [body]]
    }
    simulated_session(app)
  end

  # A label passes the user's click on with its point: an image button labeled so submits where in it that point is —
  # Chrome, clicking the label 10px in and 12px down: `im.x=-90&im.y=-88`.
  it "submits an image button at the point of its label's click" do
    s = page_session('/' => <<~HTML)
      <!DOCTYPE html><body style="margin:0"><form action="/sub"><label id=l style="display:block;width:200px;height:40px">L<input
      type=image name=im src="data:," style="position:absolute;left:100px;top:100px;width:20px;height:20px"></label></form>
    HTML
    s.visit '/'
    s.find(:css, '#l').click(x: -90, y: -8)
    expect(s.find(:css, '#echo').text).to eq('/sub?im.x=-90&im.y=-88')
  end

  # A link to "" reloads the page, a Shift click opens it in a new window — Chrome's.
  it 'reloads for an empty href, and opens a window for a Shift click' do
    s = page_session('/' => '<!DOCTYPE html><a id=e href="">empty</a><a id=o href="/other">other</a><script>window.mark = 1</script>')
    s.visit '/'
    s.execute_script('window.mark = 2')
    s.find(:css, '#e').click
    expect(s.evaluate_script('window.mark')).to eq(1)
    s.find(:css, '#o').click(:shift)
    expect([s.current_path, s.windows.size]).to eq(['/', 2])
  end

  # Capybara's check / uncheck / choose click the control as a user's pointer does (Selenium's), and only where that
  # changes it; a required checkbox the user unchecked matches :user-invalid (Chrome, two real clicks). A disabled one a
  # user clicks gets no click at all (Chrome).
  it 'checks and unchecks with a pointer click, and clicks no disabled control' do
    s = page_session('/' => <<~HTML)
      <!DOCTYPE html><form><label>C <input type=checkbox id=c required></label><label>R <input type=radio name=r id=r></label>
      <input type=checkbox id=d disabled></form>
      <script>
        window.log = [];
        for (const t of ['click', 'input', 'change', 'keydown']) {
          document.addEventListener(t, (e) => log.push(t + ':' + e.target.id + (t === 'click' ? ':' + [e.detail, e.pointerType] : '')), true);
        }
      </script>
    HTML
    s.visit '/'
    taken = -> { s.evaluate_script('window.log.splice(0)') }
    s.check('C')
    expect(taken.call).to eq(['click:c:1,mouse', 'input:c', 'change:c'])
    s.check('C')
    expect(taken.call).to eq([])
    s.uncheck('C')
    expect([taken.call, s.evaluate_script('c.matches(":user-invalid")')]).to eq([['click:c:1,mouse', 'input:c', 'change:c'], true])
    s.choose('R')
    s.choose('R')
    expect(taken.call).to eq(['click:r:1,mouse', 'input:r', 'change:r'])
    s.find(:css, '#d').click
    expect([taken.call, s.evaluate_script('d.checked')]).to eq([[], false])
  end
end
