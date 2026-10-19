# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An <input>'s value algorithms (input_value.rs): a value as its number and back, and the step — each as Chrome has it.
RSpec.describe 'input value algorithms' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>x</body>']] } }

  def run(js)
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script("(function () { function input(type) { var i = document.createElement('input'); i.type = type; return i; } #{js} })()")
  end

  it 'refuses a date past what a Date holds' do
    got = run(<<~JS)
      var d = input('date'), m = input('month');
      d.value = '275760-09-14'; m.value = '922337203685477580-01';
      var last = input('date'); last.value = '275760-09-13';
      return [d.value, m.value, last.value];
    JS
    expect(got).to eq(['', '', '275760-09-13'])
  end

  it 'writes a number back as its week, its time, its number' do
    got = run(<<~JS)
      var w = input('week'), t = input('time'), n = input('number');
      w.valueAsNumber = Date.UTC(2021, 0, 1); t.valueAsNumber = 1.5; n.valueAsNumber = 212684238611834.62;
      return [w.value, t.value, n.value];
    JS
    expect(got).to eq(['2020-W53', '00:00:00.001', '212684238611834.62'])     # Chrome
  end

  it 'snaps a range onto its step, a tie away from zero' do
    got = run(<<~JS)
      var r = input('range'); r.min = 0; r.max = 1e15; r.step = 0.5; r.value = '100000000000000.5';
      return r.value;
    JS
    expect(got).to eq('100000000000001')
  end

  # What applies to an input is its type STATE's — an invalid `type` is the Text state — HTML's table of them, the
  # engine's: `list` names no datalist on a type it does not apply to, and insertHTML types into `type=foo` as into a
  # text field. Chrome 155: each figure below.
  it 'asks the input type table for list and insertHTML' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><datalist id=dl><option value=a></datalist>']] })
    s.visit '/'
    expect(s.evaluate_script(<<~'JS')).to eq(['dl', nil, nil, 'dl', 'true:hi'])
      (() => {
        const lists = ['text', 'password', 'checkbox', 'foo'].map((type) => {
          const i = document.body.appendChild(document.createElement('input'));
          i.type = type;
          i.setAttribute('list', 'dl');
          return i.list ? i.list.id : null;
        });
        const foo = document.body.appendChild(document.createElement('input'));
        foo.setAttribute('type', 'foo');
        foo.focus();
        return [...lists, document.execCommand('insertHTML', false, '<b>hi</b>') + ':' + foo.value];
      })()
    JS
  end

  # Capybara reads a field's value as Selenium does, by its `value` IDL — so the driver's answer is the sanitized one a
  # page's script reads, not the raw live value: an email typed with spaces around it read them back. Chrome: "x@y",
  # "a@b", "", "on", and a text input's as it is.
  it 'reads a field the way its value IDL does' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] })
      <!DOCTYPE html><meta charset="utf-8"><body>
      <input id="typed" type="email"><input id="e" type="email" value=" a@b "><input id="n" type="number" value="abc">
      <input id="c" type="checkbox"><input id="t" value="kept as is ">
    HTML
    s.visit '/'
    s.find('#typed').set(' x@y ')
    expect(%w[typed e n c t].map {|id| s.find("##{id}").value }).to eq(['x@y', 'a@b', '', 'on', 'kept as is '])
  end
end
