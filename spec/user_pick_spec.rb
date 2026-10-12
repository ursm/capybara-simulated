# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A user's pick of an option, and an arrow key's default action on a focused radio button or single select, are the
# engine's (validity.rs `optionPick` / `arrowDefault`): which option or radio button they land on, what they deselect
# and uncheck, and whether anything changed — the select's `input` / `change` fired only then.
RSpec.describe 'User picks' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8>
        <select id=one><option>a<option disabled>b<option>c</select>
        <select id=many multiple><option selected>x<option>y<optgroup disabled><option>z</optgroup></select>
        <input type=radio name=g id=r1 checked><input type=radio name=g id=r2 disabled><input type=radio name=g id=r3>
        <input type=range id=range min=0 max=10 step=4>
        <script>
          window.fired = [];
          for (const el of document.querySelectorAll('select, input')) {
            for (const type of ['input', 'change']) el.addEventListener(type, () => fired.push(type + ':' + el.id));
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
    expect(state('one')).to eq(%w[c])
    session.find('#one').send_keys(:down)
    expect([state('one'), session.evaluate_script('fired')]).to eq([%w[c], %w[input:one change:one]])
  end

  it 'checks and focuses the next radio button of the group not disabled, wrapping' do
    session.find('#r1').send_keys(:right)
    expect(session.evaluate_script('[r1.checked, r3.checked, document.activeElement.id]')).to eq([false, true, 'r3'])
    session.find('#r3').send_keys(:right)
    expect(session.evaluate_script('[r1.checked, r3.checked, document.activeElement.id]')).to eq([true, false, 'r1'])
  end

  it 'sets a range to the nearest value on its step' do
    session.find('#range').set('7')
    expect(session.evaluate_script('range.value')).to eq('8')
  end
end
