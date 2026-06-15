require_relative 'spec_helper'
require 'capybara/dsl'
require 'tempfile'

# `CSSStyleDeclaration.setProperty(name, value, priority)` and the `!important`
# round-trip. Capybara's `attach_file ..., make_visible: true` calls
# `el.style.setProperty(prop, val, "important")` on the hidden file input, then
# asserts `element.visible?`. Apps routinely hide that input with
# `display: none !important`, so the inline override must be marked important
# too — otherwise it loses to the stylesheet rule and make_visible raises
# "The style changes in :make_visible did not make the file input visible".
RSpec.describe 'CSSStyleDeclaration setProperty / !important' do
  include Capybara::DSL

  let(:app) {
    lambda do |env|
      req = Rack::Request.new(env)
      if env['REQUEST_METHOD'] == 'POST'
        n = Array(req.params['files']).size
        [200, {'content-type' => 'text/html'}, ["<!doctype html><body><div id='done'>got #{n}</div></body>"]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><style>
            input[type=file] { display: none !important; }
            #probe.win { color: blue !important; }
          </style></head><body>
            <form action="/" method="post" enctype="multipart/form-data">
              <label for="up">画像を追加</label>
              <input type="file" id="up" name="files[]" multiple>
              <button type="submit">send</button>
            </form>
            <div id="probe" style="color: red"></div>
          </body></html>
        HTML
      end
    end
  }

  before do
    Capybara.app = app
    Capybara.default_driver = :simulated
    visit '/'
  end

  def probe = find(:css, '#probe', visible: false)

  it 'marks a declaration important when setProperty is given "important"' do
    probe.execute_script("this.style.setProperty('display', 'block', 'important')")
    expect(probe.evaluate_script("this.style.getPropertyValue('display')")).to eq('block')
    expect(probe.evaluate_script("this.style.getPropertyPriority('display')")).to eq('important')
    # CSSOM serialization keeps the priority; getPropertyValue / .display drop it.
    expect(probe.evaluate_script('this.style.cssText')).to include('display: block !important')
    expect(probe.evaluate_script('this.style.display')).to eq('block')
  end

  it 'leaves the declaration normal when no priority is passed' do
    probe.execute_script("this.style.setProperty('display', 'block')")
    expect(probe.evaluate_script("this.style.getPropertyPriority('display')")).to eq('')
    expect(probe.evaluate_script('this.style.cssText')).not_to include('!important')
  end

  it 'honours !important embedded in a camelCase assignment' do
    probe.execute_script("this.style.display = 'block !important'")
    expect(probe.evaluate_script("this.style.getPropertyPriority('display')")).to eq('important')
    expect(probe.evaluate_script('this.style.display')).to eq('block')
  end

  it 'reflects an important inline override in getComputedStyle' do
    # The input is hidden by `display: none !important`; an inline important
    # override must flip the resolved value.
    el = find(:css, '#up', visible: false)
    expect(el.evaluate_script('getComputedStyle(this).display')).to eq('none')
    el.execute_script("this.style.setProperty('display', 'block', 'important')")
    expect(el.evaluate_script('getComputedStyle(this).display')).to eq('block')
    expect(el).to be_visible
  end

  it 'scopes inline !important to its own declaration, not the whole style attribute' do
    # An `!important` on one inline property must not mark sibling inline
    # properties important. Here inline `color: red` is normal, so a stylesheet
    # `!important` color rule must still win — even though a SIBLING inline
    # declaration (`text-transform`) is `!important`.
    probe.execute_script("this.style.setProperty('text-transform', 'uppercase', 'important'); this.classList.add('win')")
    expect(probe.evaluate_script('getComputedStyle(this).color')).to eq('rgb(0, 0, 255)')
  end

  it 'attaches a file to an input hidden with display:none !important via make_visible' do
    tmp = Tempfile.new(['up', '.png'])
    tmp.write('png-bytes'); tmp.flush
    attach_file '画像を追加', [tmp.path, tmp.path], make_visible: true
    find(:css, 'button', text: 'send').click
    expect(page).to have_css('#done', text: 'got 2')
  ensure
    tmp&.close!
  end
end
