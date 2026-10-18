# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# User activation (HTML §6.4.3) is each window's last activation timestamp, the engine's (user_activation.rs): a user's
# click activates its window, its ancestors' and its same-origin descendants' — sticky from then on, transient for five
# seconds of the window's clock — and an activation-gated API consumes it in every window of the page. A window had been
# stickily activated from the start, transiently so until something consumed it however long ago, and a click in the
# page left its frames unactivated.
RSpec.describe 'user activation' do
  it "is a window's last activation, sticky, transient for a while, and consumed page-wide" do
    page = '<!DOCTYPE html><meta charset=utf-8><body><button>b</button><iframe srcdoc="<select><option>o</select>"></iframe>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    read = 'const u = (w) => [w.navigator.userActivation.hasBeenActive, w.navigator.userActivation.isActive]; return [u(window), u(frames[0])]'
    expect(s.evaluate_script("(() => { #{read} })()")).to eq([[false, false], [false, false]])
    s.find('button').click
    expect(s.evaluate_script("(() => { #{read} })()")).to eq([[true, true], [true, true]])
    s.evaluate_script("frames[0].document.querySelector('select').showPicker()")
    expect(s.evaluate_script("(() => { #{read} })()")).to eq([[true, false], [true, false]])
    s.find('button').click
    s.execute_script('setTimeout(() => { window.later = navigator.userActivation.isActive; }, 6000)')
    expect(poll_until(timeout: 15) { v = s.evaluate_script('window.later'); v.nil? ? nil : [v] }).to eq([false])
  end

  # (…the initial about:blank window of a frame no script has looked into, whose realm is made later, among the same-
  # origin descendants a click activates — Chrome 154: [true, true] — and a new top-level window a click opens consuming
  # it, as HTML's rules for choosing a navigable have it: `window.open` had left it active)
  it 'reaches a frame not built yet, and is consumed by a window opened' do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body><iframe></iframe>
      <button id=open onclick="window.open('/p'); window.after = navigator.userActivation.isActive">o</button>
      <button id=plain>b</button>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s.find('#plain').click
    expect(s.evaluate_script('[frames[0].navigator.userActivation.hasBeenActive, frames[0].navigator.userActivation.isActive]')).to eq([true, true])
    s.find('#open').click
    expect(s.evaluate_script('[window.after, navigator.userActivation.hasBeenActive]')).to eq([false, true])
  end
end
