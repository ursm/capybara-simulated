require 'capybara/simulated'
require_relative 'support/session_teardown'

# getComputedStyle's resolved values (resolved.rs): a used value is read off the box the layout placed, so a read of one
# lays the page out first — and a read whose answer the style alone gives lays out nothing. A page that dirties its
# layout and reads a value every frame pays a layout pass per read otherwise.
RSpec.describe 'resolved values' do
  def session(body)
    app = ->(_env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><html><body>#{body}</body></html>"]] }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  # How many layout passes reading `property` of `#t` runs, each read after a write that dirties the layout — and the
  # last value read.
  def passes_reading(s, property)
    s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t'), d = document.getElementById('dirty');
        const before = globalThis.__csimLayoutPasses();
        let v;
        for (let i = 0; i < 5; i++) { d.style.paddingLeft = i + 'px'; v = getComputedStyle(t)[#{property.to_json}]; }
        return [globalThis.__csimLayoutPasses() - before, v];
      })()
    JS
  end

  let(:s) do
    session(<<~HTML)
      <div id="dirty">d</div>
      <div style="display: none"><div id="hidden" style="width: 50%">x</div></div>
      <span id="span" style="width: 10em">s</span>
      <div id="plain">p</div>
      <div id="moved" style="transform: translateX(10px)">m</div>
      <div id="sized" style="width: 30%">w</div>
    HTML
  end

  it 'lays out nothing for an element with no box, a non-replaced inline width, or a transform with no percentage' do
    {'hidden' => ['width', '50%'], 'span' => ['width', '160px'], 'plain' => ['transform', 'none'],
     'moved' => ['transform', 'matrix(1, 0, 0, 1, 10, 0)']}.each do |id, (property, value)|
      s.execute_script("document.querySelectorAll('[id=t]').forEach((e) => e.removeAttribute('id')); document.getElementById('#{id}').id = 't'")
      expect(passes_reading(s, property)).to eq([0, value]), id
    end
  end

  it 'lays out a box whose used value it reads' do
    s.execute_script("document.getElementById('sized').id = 't'")
    passes, value = passes_reading(s, 'width')
    expect(passes).to eq(5)
    expect(value).to match(/\A\d+(\.\d+)?px\z/)
  end
end
