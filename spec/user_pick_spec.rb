# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A user's pick of an option, and an arrow key's default action on a focused radio button or single select, are the
# engine's (validity.rs `optionPick` / `arrowDefault`): which option or radio button they land on, what they deselect
# and uncheck, and whether anything changed — the select's `input` / `change` fired only then. The arrow keys' events
# are Chrome's, measured with real key presses: a radio button focused, then clicked (`click`, `input`, `change`); a
# select's `input` and `change`, and its `:user-valid`.
RSpec.describe 'User picks' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8>
        <select id=one><option>a<option disabled>b<option>c</select>
        <select id=many multiple><option selected>x<option>y<optgroup disabled><option>z</optgroup></select>
        <input type=radio name=g id=r1 checked><input type=radio name=g id=r2 disabled><input type=radio name=g id=r3>
        <input type=range id=range min=0 max=10 step=4>
        <input type=range id=based value=5 step=10>
        <select id=past><option>a<option>b<option selected disabled>c<option>d</select>
        <script>
          window.fired = [];
          for (const el of document.querySelectorAll('select, input')) {
            for (const type of ['focus', 'click', 'input', 'change']) el.addEventListener(type, () => fired.push(type + ':' + el.id));
          }
        </script>
      HTML
    }
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  def state(select)
    session.evaluate_script("[...document.getElementById('#{select}').options].filter((o) => o.selected).map((o) => o.text)")
  end

  it 'fires nothing for a pick of the option already selected' do
    session.find('#one').find('option', text: 'a').select_option
    expect(session.evaluate_script('fired')).to eq([])
  end

  it 'deselects the rest of a single select and fires its events' do
    session.find('#one').find('option', text: 'c').select_option
    expect([state('one'), session.evaluate_script('fired')]).to eq([%w[c], %w[input:one change:one]])
  end

  it 'picks nothing in a disabled optgroup' do
    session.find('#many').find('option', text: 'z').select_option
    expect([state('many'), session.evaluate_script('fired')]).to eq([%w[x], []])
  end

  it 'keeps the other picks of a multiple select, and unpicks one' do
    session.find('#many').find('option', text: 'y').select_option
    session.find('#many').find('option', text: 'x').unselect_option
    expect([state('many'), session.evaluate_script('fired')]).to eq([%w[y], %w[input:many change:many input:many change:many]])
  end

  it 'moves a single select past a disabled option with the arrow keys, stopping at its end' do
    session.find('#one').send_keys(:down)
    expect([state('one'), session.evaluate_script("one.matches(':user-valid')")]).to eq([%w[c], true])
    session.execute_script('fired.length = 0')
    session.find('#one').send_keys(:down)
    expect([state('one'), session.evaluate_script('fired')]).to eq([%w[c], []])
  end

  it 'moves a select on from a disabled option selected' do
    session.find('#past').send_keys(:down)
    expect(state('past')).to eq(%w[d])
  end

  it 'focuses and clicks the next radio button of the group not disabled, wrapping' do
    session.find('#r1').send_keys(:right)
    session.execute_script("fired = fired.filter((e) => !e.endsWith(':r1'))")
    expect(session.evaluate_script('[r1.checked, r3.checked, document.activeElement.id, fired]')).to eq(
      [false, true, 'r3', %w[focus:r3 click:r3 input:r3 change:r3]]
    )
    session.find('#r3').send_keys(:right)
    expect(session.evaluate_script('[r1.checked, r3.checked, document.activeElement.id]')).to eq([true, false, 'r1'])
  end

  it 'leaves a radio button unchecked where its click is canceled' do
    session.execute_script("r3.addEventListener('click', (e) => e.preventDefault())")
    session.find('#r1').send_keys(:right)
    expect(session.evaluate_script('[r1.checked, r3.checked, document.activeElement.id]')).to eq([true, false, 'r3'])
  end

  it 'sets a range to the nearest value on its step' do
    session.find('#range').set('7')
    expect(session.evaluate_script('range.value')).to eq('8')
  end

  it 'steps a range with no min from its value attribute, as Chrome' do
    session.find('#based').set('12')
    expect(session.evaluate_script('based.value')).to eq('15')
  end
end
