# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The user typing into a text control (text_selection.rs `type_text`): at its selection, `maxlength` cutting it short,
# a number field refusing a keystroke that leaves no number being entered. Every expectation is Chrome's.
RSpec.describe 'typing into a text control' do
  it 'inserts at the selection, cut at maxlength, a number field keeping a number' do
    html = <<~HTML
      <!DOCTYPE html><input id=m maxlength=3><input id=n type=number><input id=s value=hello><textarea id=t maxlength=" 4x"></textarea>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    s.find(:css, '#m').send_keys('abcde')
    s.find(:css, '#n').send_keys('1e+1-')
    s.execute_script("const s = document.getElementById('s'); s.focus(); s.setSelectionRange(1, 3);")
    s.find(:css, '#s').send_keys('X')
    s.find(:css, '#t').send_keys('abcdef')
    expect(s.evaluate_script(<<~JS)).to eq(['abc', '1e+1', false, 'hXlo', 2, 'abcd'])
      (() => {
        const g = (id) => document.getElementById(id);
        return [g('m').value, g('n').value, g('n').validity.badInput, g('s').value, g('s').selectionStart, g('t').value];
      })()
    JS
  end

  # The editing keys: Backspace / Delete remove the selection or the character before / after the caret, a surrogate
  # pair one; the arrows collapse a selection to its start / end or step a character; Home / End go to the ends of the
  # caret's line in a textarea.
  it 'takes the editing keys as Chrome does' do
    html = "<!DOCTYPE html><meta charset=utf-8><input id=i value=hello><textarea id=t>ab\ncd</textarea>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    state = ->(id) { s.evaluate_script("(() => { const e = document.getElementById('#{id}'); return [e.value, e.selectionStart, e.selectionEnd]; })()") }
    press = ->(id, from, to, key, value = nil) {
      s.execute_script("(() => { const e = document.getElementById('#{id}'); #{value ? "e.value = #{value.to_json};" : ''} e.focus(); e.setSelectionRange(#{from}, #{to}); })()")
      s.find(:css, "##{id}").send_keys(key)
      state.(id)
    }
    expect([
      press.('i', 1, 3, :left), press.('i', 1, 3, :right), press.('i', 1, 3, :delete), press.('i', 1, 1, :delete),
      press.('i', 3, 3, :backspace, "a\u{1F600}b"), press.('i', 1, 1, :delete, "a\u{1F600}b"), press.('i', 1, 1, :right, "a\u{1F600}b"),
      press.('t', 4, 4, :home), press.('t', 1, 1, :end), press.('i', 0, 0, :backspace)
    ]).to eq([
      ['hello', 1, 1], ['hello', 3, 3], ['hlo', 1, 1], ['ho', 1, 1], ['ab', 1, 1], ['ab', 1, 1], ["a\u{1F600}b", 3, 3],
      ["ab\ncd", 3, 3], ["ab\ncd", 2, 2], ["a\u{1F600}b", 0, 0]
    ])
  end

  # Shift extends the selection from its anchor, its direction following; Ctrl+Home / Ctrl+End go to the value's ends;
  # `maxlength` takes as much of the typed text as it has room for, a surrogate pair whole or not at all, leaving the
  # rest of the value whole (0 takes nothing); Delete and the arrows step a grapheme cluster, Backspace a code point but
  # an emoji sequence or a flag whole.
  it 'extends, cuts and steps as Chrome does' do
    html = "<!DOCTYPE html><meta charset=utf-8><input id=i value=abcdef><textarea id=t>ab\ncd</textarea><input id=m maxlength=5><input id=z maxlength=0><input id=g>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    state = ->(id) { s.evaluate_script("(() => { const e = document.getElementById('#{id}'); return [e.value, e.selectionStart, e.selectionEnd, e.selectionDirection]; })()") }
    select = ->(id, from, to, direction = 'none', value = nil) {
      s.execute_script("(() => { const e = document.getElementById('#{id}'); #{value ? "e.value = #{value.to_json};" : ''} e.focus(); e.setSelectionRange(#{from}, #{to}, '#{direction}'); })()")
    }
    keys = ->(id, *k) { s.find(:css, "##{id}").send_keys(*k); state.(id)[0..2] }
    got = []
    select.('i', 2, 2)
    got << keys.('i', [:shift, :left]) << keys.('i', [:shift, :left]) << keys.('i', [:shift, :right])
    select.('i', 2, 4, 'forward')
    got << keys.('i', [:shift, :left])
    select.('t', 5, 5)
    got << keys.('t', [:control, :home])
    select.('t', 0, 0)
    got << keys.('t', [:control, :end])
    select.('t', 4, 4)
    got << keys.('t', [:shift, :home])
    [['abcde', 0, 0, 'X'], ['abcdefg', 7, 7, 'h'], ['ab', 1, 1, 'XYZW'], ['abcd', 4, 4, "\u{1F600}"], ['abcde', 1, 3, 'XYZ']].each do |value, from, to, text|
      select.('m', from, to, 'none', value)
      got << keys.('m', text)
    end
    select.('z', 0, 0)
    got << keys.('z', 'q')
    [["ae\u0301b", 1, :delete], ["ae\u0301b", 3, :left], ["a\u{1F1EF}\u{1F1F5}b", 5, :left], ["a\u{1F1EF}\u{1F1F5}b", 5, :backspace],
     ["ae\u0301b", 3, :backspace], ["a\u{1F44D}\u{1F3FD}b", 5, :backspace]].each do |value, at, key|
      select.('g', at, at, 'none', value)
      got << keys.('g', key)
    end
    expect(got).to eq([
      ['abcdef', 1, 2], ['abcdef', 0, 2], ['abcdef', 1, 2], ['abcdef', 2, 3], ["ab\ncd", 0, 0], ["ab\ncd", 5, 5], ["ab\ncd", 3, 4],
      ['abcde', 0, 0], ['abcdefg', 7, 7], ['aXYZb', 4, 4], ['abcd', 4, 4], ['aXYde', 3, 3], ['', 0, 0],
      ['ab', 1, 1], ["ae\u0301b", 1, 1], ["a\u{1F1EF}\u{1F1F5}b", 1, 1], ['ab', 1, 1], ['aeb', 2, 2], ['ab', 1, 1]
    ])
  end

  # A value written by another realm's code moves the style state of the control's own realm, whose `:placeholder-shown`
  # rule stops applying.
  it "restyles a frame's control a parent's script writes" do
    html = <<~HTML
      <!DOCTYPE html><iframe id=f srcdoc="<style>input{width:100px} input:placeholder-shown{width:300px}</style><input id=i placeholder=p>"></iframe>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~JS)).to eq(%w[300px 100px])
      (() => {
        const w = document.getElementById('f').contentWindow, i = w.document.getElementById('i');
        const before = w.getComputedStyle(i).width;
        document.body.offsetWidth;   // (…this realm's own read between, its layout this realm's)
        i.value = 'x';
        document.body.offsetWidth;
        return [before, w.getComputedStyle(i).width];
      })()
    JS
  end

  # execCommand types at the selection a script reads — its start where none was set — and its `input` event's data is
  # what went in: as much as `maxlength` has room for; insertText into a number field too, not a date's.
  it 'types an execCommand at the selection a script reads' do
    html = <<~HTML
      <!doctype html><meta charset=utf-8><body><input id=i value=abc><textarea id=t>abc</textarea><input id=e type=email value=a@b><input id=m maxlength=3 value=ab><input id=n type=number><input id=d type=date>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~JS)).to eq(['Xabc,1', 'Xabc,1', 'Qa@b,Q', 'abX,X', '5', 'false,'])
      (() => {
        const $ = (q) => document.querySelector(q), R = [];
        let e = $('#i'); e.focus(); document.execCommand('insertText', false, 'X'); R.push([e.value, e.selectionStart].join());
        e = $('#t'); e.focus(); document.execCommand('insertText', false, 'X'); R.push([e.value, e.selectionStart].join());
        let d; e = $('#e'); e.focus(); e.addEventListener('input', (ev) => d = ev.data); document.execCommand('insertHTML', false, '<b>Q</b>'); R.push([e.value, d].join());
        let d2; e = $('#m'); e.focus(); e.setSelectionRange(2, 2); e.addEventListener('input', (ev) => d2 = ev.data); document.execCommand('insertText', false, 'XYZ'); R.push([e.value, d2].join());
        e = $('#n'); e.focus(); document.execCommand('insertText', false, '5'); R.push(e.value);
        e = $('#d'); e.focus(); R.push([document.execCommand('insertText', false, '5'), e.value].join());
        return R;
      })()
    JS
  end
end
