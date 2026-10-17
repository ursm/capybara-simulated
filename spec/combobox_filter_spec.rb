# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# open-ui customizable-combobox filtering (tentative): an `<input filter=ID>` filters its `<select>`'s options, an
# `<input list=ID>` its `<datalist>`'s, by its value — an option whose `text` does not start with it, both lowercased,
# matches `:filtered` — after a cancelable `beforefilter` at the input that keeps the filtering it had.
RSpec.describe 'combobox filtering' do
  def session
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <input id="f" filter="s"><select id="s"><option>Apple</option><optgroup><option> apricot </option></optgroup><option>Banana</option></select>
      <input id="l" list="d"><datalist id="d"><div><option>Cherry</option></div><option>Citrus</option><option>Date</option></datalist>
      <input id="n" list="nothing"><input id="p" list="f"><input id="e" list=""><datalist id=""><option>Zed</option></datalist>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s
  end

  def filtered(s, list)
    s.evaluate_script("Array.from(document.querySelectorAll('##{list} option'), (o) => o.matches(':filtered'))")
  end

  it "filters a select's options and a datalist's by the value" do
    s = session
    s.execute_script("document.getElementById('f').value = 'AP'")
    expect(filtered(s, 's')).to eq([false, false, true])
    s.execute_script("document.getElementById('l').value = 'c'")
    expect(filtered(s, 'd')).to eq([false, false, true])
    s.execute_script("document.getElementById('l').value = 'cit'")
    expect(filtered(s, 'd')).to eq([true, false, true])
  end

  it 'clears the filtering for an empty value' do
    s = session
    s.execute_script("const f = document.getElementById('f'); f.value = 'b'; f.value = ''")
    expect(filtered(s, 's')).to eq([false, false, false])
  end

  it 'keeps the filtering it had where `beforefilter` is canceled' do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq([1, [false, false, true]])
      (() => {
        const f = document.getElementById('f');
        let fired = 0;
        f.value = 'a';
        f.addEventListener('beforefilter', (e) => { fired++; e.preventDefault(); });
        f.value = 'b';
        return [fired, Array.from(document.querySelectorAll('#s option'), (o) => o.matches(':filtered'))];
      })()
    JS
  end

  it "filters an option by its `text` — a script's text left out, its whitespace collapsed" do
    s = session
    s.execute_script(<<~JS)
      const s = document.getElementById('s');
      s.firstElementChild.prepend(Object.assign(document.createElement('script'), {text: 'x'}));
      s.lastElementChild.textContent = '  Ban  ana ';
    JS
    s.execute_script("document.getElementById('f').value = 'appl'")
    expect(filtered(s, 's')).to eq([false, true, true])
    s.execute_script("document.getElementById('f').value = 'ban a'")
    expect(filtered(s, 's')).to eq([true, true, false])
  end

  it 'filters the options a `beforefilter` listener added' do
    s = session
    s.execute_script(<<~JS)
      const f = document.getElementById('f');
      f.addEventListener('beforefilter', () => { document.getElementById('s').append(new Option('Cherry')); });
      f.value = 'a';
    JS
    expect(filtered(s, 's')).to eq([false, false, true, true])
  end

  it 'fires nothing for a list that is none — an empty ID names no element — or no select or datalist' do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq(0)
      (() => {
        let fired = 0;
        for (const id of ['n', 'p', 'e']) {
          const input = document.getElementById(id);
          input.addEventListener('beforefilter', () => { fired++; });
          input.value = 'x';
        }
        return fired;
      })()
    JS
  end
end
