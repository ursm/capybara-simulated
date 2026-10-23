# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A navigation of the page its document plans as it loads — its location set, a form submitted, a link followed, by its
# parse, a `load` handler or a task its load runs — is under way as the visit ends, as a browser starts it then: an
# auto-submitting page (an OAuth `form_post`) has navigated by the time `current_path` is read.
RSpec.describe 'a navigation a page plans as it loads' do
  {
    'its location set as it parses' => '<script>location.href = "/b"</script>',
    'a form submitted as it parses' => '<form id=f action="/b"><input name=q value=1></form><script>f.submit()</script>',
    'a form submitted on its load'  => '<form id=f action="/b"><input name=q value=1></form><script>addEventListener("load", () => f.submit())</script>',
    'a link clicked as it parses'   => '<a id=a href="/b">x</a><script>a.click()</script>',
    'a form submitted on a task'    => '<form id=f action="/b"><input name=q value=1></form><script>setTimeout(() => f.submit(), 0)</script>'
  }.each do |name, body|
    it "has navigated by the end of the visit: #{name}" do
      session = simulated_session(lambda {|env|
        next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>B']] if env['PATH_INFO'] == '/b'

        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>A#{body}"]]
      })
      session.visit '/'
      expect(session.current_path).to eq('/b')
      expect(session.evaluate_script('document.body.textContent')).to eq('B')
    end
  end
end
