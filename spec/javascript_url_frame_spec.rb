# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A `javascript:` URL frame's script runs in the frame's initial about:blank document (HTML "evaluate a javascript:
# URL"): its URL is about:blank, and its base URL its creator's, so a relative URL there resolves against the parent.
RSpec.describe 'a javascript: URL frame' do
  include PollUntil

  it 'runs in an about:blank document of its creator’s base URL' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        window.got = null;
        document.body.appendChild(document.createElement('iframe')).src =
          "javascript:parent.got = [document.URL, location.href, document.baseURI]";
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/dir/p.html'
    expect(poll_until { s.evaluate_script('window.got') }).to eq(['about:blank', 'about:blank', 'http://www.example.com/dir/p.html'])
  end
end
