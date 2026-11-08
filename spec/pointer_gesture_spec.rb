# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The mouse pointer's gestures as the engine sequences them (pointer.rs `MousePointer`): `:active` while a button is held,
# pointer capture, a press dragged off its element clicking what the press and the release share, a double click's word.
# Every expectation is Chrome's and Firefox's (a real pointer — CDP Input.dispatchMouseEvent, WebDriver BiDi
# input.performActions — over the same boxes, 2026-11-08), but where they differ, as noted.
RSpec.describe 'pointer gestures' do
  html = <<~HTML
    <!DOCTYPE html><meta charset=utf-8>
    <style>body{margin:0} div{position:absolute;box-sizing:border-box}
    #out{left:0;top:0;width:400px;height:150px} #a{left:20px;top:20px;width:100px;height:60px}
    #a1{left:10px;top:10px;width:40px;height:30px} #b{left:200px;top:20px;width:100px;height:60px}
    #c{left:20px;top:200px;width:100px;height:60px}
    label{position:absolute;top:300px;width:80px;height:30px} #lab{left:400px} #lab2{left:500px}
    #ed{left:20px;top:400px}</style>
    <div id=out><div id=a><div id=a1></div></div><div id=b></div></div><div id=c></div>
    <label id=lab>L<input id=li></label><input id=li2><label id=lab2 for=li2>L2</label>
    <div id=ed contenteditable>hello</div>
    <script>
      window.log = [];
      window.hooks = {};
      const name = (t) => t ? (t.id || t.nodeName) : null;
      const states = (sel) => [...document.querySelectorAll(sel)].map(name).filter((n) => n !== 'HTML' && n !== 'BODY').join('/');
      for (const type of ['pointerover', 'pointerout', 'pointermove', 'pointerdown', 'pointerup', 'gotpointercapture',
                          'lostpointercapture', 'mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup', 'click',
                          'auxclick', 'dblclick', 'contextmenu'])
        window.addEventListener(type, (e) => {
          if (!window.rec) return;
          log.push([type, name(e.target), 'b' + e.button, 'bs' + e.buttons, 'd' + e.detail, 'act:' + states(':active')].join(' '));
          const hook = hooks[type + ':' + name(e.target)];
          if (hook) hook(e);
        }, true);
    </script>
  HTML
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }) }

  def gesture
    session.visit '/'
    session.find('#c').hover
    session.execute_script(yield.to_s + ';window.rec = true')
    nil
  end
  def log = session.evaluate_script('log.splice(0)')
  def capture_in(event, element)
    "hooks['#{event}'] = (e) => document.getElementById('#{element}').setPointerCapture(e.pointerId)"
  end

  it 'holds the pressed element and its ancestors :active from its pointerdown to its pointerup, any button' do
    gesture { '' }
    session.find('#a1').click
    expect(log.grep(/^(pointerdown|mousedown|pointerup|click)/)).to eq([
      'pointerdown a1 b0 bs1 d0 act:out/a/a1',
      'mousedown a1 b0 bs1 d1 act:out/a/a1',
      'pointerup a1 b0 bs0 d0 act:',
      'click a1 b0 bs0 d1 act:'
    ])
    session.find('#a').right_click
    expect(log.grep(/^(pointerdown|contextmenu|pointerup|auxclick)/)).to eq([
      'pointerdown a b2 bs2 d0 act:out/a',
      'contextmenu a b2 bs2 d1 act:out/a',
      'pointerup a b2 bs0 d0 act:',
      'auxclick a b2 bs0 d1 act:'
    ])
    # (…a canceled pointerdown activates it all the same, its mouse events held back)
    session.execute_script("hooks['pointerdown:a1'] = (e) => e.preventDefault()")
    session.find('#a1').click
    expect(log.grep(/^(pointer|mouse)(down|up)|^click/)).to eq([
      'pointerdown a1 b0 bs1 d0 act:out/a/a1',
      'pointerup a1 b0 bs0 d0 act:',
      'click a1 b0 bs0 d1 act:'
    ])
  end

  it "matches a label's labeled control as the label is :hover and :active (HTML §4.16.3)" do
    gesture { "hooks['mousedown:lab2'] = () => log.push('pressed ' + states(':active') + ' over ' + states(':hover'))" }
    session.find('#lab2').click
    expect(log).to include('pressed li2/lab2 over li2/lab2')
    expect(session.evaluate_script("[document.getElementById('li2').matches(':hover'), document.getElementById('li2').matches(':active')]")).to eq([true, false])
  end

  it "clicks what a pointer-driven drag's press and release share, and moves the pointer over the target" do
    gesture { "hooks['mousedown:a1'] = (e) => e.preventDefault()" }
    session.find('#a1').drag_to(session.find('#b'))
    lines = log
    expect(lines).to include('pointerover b b-1 bs1 d0 act:out/a/a1', 'mouseover b b0 bs1 d0 act:out/a/a1')
    expect(lines.last(3)).to eq(['pointerup b b0 bs0 d0 act:', 'mouseup b b0 bs0 d1 act:', 'click out b0 bs0 d1 act:'])
  end

  # (…Pointer Events §10: the capture's target gets it before the next pointer event, which — and its compatibility mouse
  # event — goes to it; it loses it right after the `pointerup` (§10.5, Firefox: Chrome after the `mouseup`), the pointer's
  # boundary events going back to what it is over, and the click is at it)
  it 'targets the pointer events at the element that captured the pointer, until its release' do
    gesture { capture_in('pointerdown:a1', 'a1') + ";hooks['mousedown:a1'] = (e) => e.preventDefault()" }
    session.find('#a1').drag_to(session.find('#b'))
    expect(log.grep_v(/^pointerover|^pointerout|^mouseover|^mouseout/).drop_while {|l| !l.start_with?('pointerdown') }).to eq([
      'pointerdown a1 b0 bs1 d0 act:out/a/a1',
      'mousedown a1 b0 bs1 d1 act:out/a/a1',
      'gotpointercapture a1 b-1 bs1 d0 act:out/a/a1',
      'pointermove a1 b-1 bs1 d0 act:out/a/a1',
      'mousemove a1 b0 bs1 d0 act:out/a/a1',
      'pointermove a1 b-1 bs1 d0 act:out/a/a1',
      'mousemove a1 b0 bs1 d0 act:out/a/a1',
      'pointerup a1 b0 bs0 d0 act:',
      'lostpointercapture a1 b0 bs0 d0 act:',
      'mouseup a1 b0 bs0 d1 act:',
      'click a1 b0 bs0 d1 act:'
    ])
    expect(session.evaluate_script("document.querySelector(':hover:not(html, body, #out)').id")).to eq('b')
  end

  it 'moves the pointer over another element that captures it before the release' do
    gesture { capture_in('pointerdown:a1', 'b') }
    session.find('#a1').click
    expect(log.drop_while {|l| !l.start_with?('mousedown') }).to eq([
      'mousedown a1 b0 bs1 d1 act:out/a/a1',
      'pointerout a1 b-1 bs0 d0 act:',
      'pointerover b b-1 bs0 d0 act:',
      'gotpointercapture b b-1 bs0 d0 act:',
      'mouseout a1 b0 bs0 d0 act:',
      'mouseover b b0 bs0 d0 act:',
      'pointerup b b0 bs0 d0 act:',
      'lostpointercapture b b0 bs0 d0 act:',
      'pointerout b b-1 bs0 d0 act:',
      'pointerover a1 b-1 bs0 d0 act:',
      'mouseup b b0 bs0 d1 act:',
      'click b b0 bs0 d1 act:',
      'mouseout b b0 bs0 d0 act:',
      'mouseover a1 b0 bs0 d0 act:'
    ])
  end

  it "refuses another pointer's capture and an unconnected element's, and takes none with no button held" do
    gesture { '' }
    expect(session.evaluate_script(<<~JS)).to eq(['NotFoundError', 'InvalidStateError', false, 'NotFoundError'])
      (() => {
        const a = document.getElementById('a'), out = [];
        for (const f of [() => a.setPointerCapture(7), () => document.createElement('i').setPointerCapture(1),
                         () => { a.setPointerCapture(1); return a.hasPointerCapture(1); }, () => a.releasePointerCapture(2)]) {
          try { out.push(f()); } catch (e) { out.push(e.name); }
        }
        return out;
      })()
    JS
  end

  # (…Chrome's: Firefox counts the clicks of a WebDriver BiDi action itself, and the probe's two made no double click)
  it "selects the word at a double click's second press, before its mouseup and dblclick" do
    gesture { "for (const t of ['mousedown', 'mouseup', 'dblclick']) document.getElementById('ed').addEventListener(t, (e) => log.push(t + e.detail + ':' + getSelection())); ''" }
    session.find('#ed').double_click
    expect(log.grep(/^(mousedown|mouseup|dblclick)\d/)).to eq(['mousedown1:', 'mouseup1:', 'mousedown2:', 'mouseup2:hello', 'dblclick2:hello'])
  end
end
