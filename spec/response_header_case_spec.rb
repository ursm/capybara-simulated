# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A response's headers are read by name ASCII case-insensitively — a Rack 2 app may spell one any way: a redirect's
# `Location` and its target's `Content-Type` alike.
RSpec.describe 'response header names in any case' do
  it 'follows a redirect and types a page whatever case their headers are in' do
    app = lambda {|env|
      case env['PATH_INFO']
      when '/'   then [302, {'LoCaTiOn' => '/to'}, ['']]
      when '/to' then [200, {'CONTENT-TYPE' => 'text/plain'}, ['<b>plain</b>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    expect([s.current_path, s.evaluate_script('document.contentType')]).to eq(['/to', 'text/plain'])
  end
end
