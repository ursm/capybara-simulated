# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An inline module script is a module script of its own each time, in no module map (HTML "create a JavaScript module
# script"): two of the same text both run, and each one's `import.meta.url` is its document's base URL, fragment and all
# (Chrome: `http://…/d.html#frag`).
RSpec.describe 'an inline module script' do
  let(:page) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <script type="module">(window.urls ||= []).push(import.meta.url);</script>
      <script type="module">(window.urls ||= []).push(import.meta.url);</script>
    HTML
  }

  it 'runs each time its text appears, its URL the document base URL' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/d.html#frag'
    expect(s.evaluate_script('window.urls')).to eq(['http://www.example.com/d.html#frag'] * 2)
  end
end
