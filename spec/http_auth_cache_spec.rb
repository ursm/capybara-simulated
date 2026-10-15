# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Credentials a request carries (XMLHttpRequest open()'s user and password, a URL's userinfo) answer a 401 challenge;
# only one answered — accepted — is kept for the origin and sent ahead of the next request. One no server ever asked
# for is sent with nothing later (Chrome, measured: the next request carries no Authorization).
RSpec.describe 'HTTP authentication entries' do
  let(:seen) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_AUTHORIZATION']]
      if env['PATH_INFO'] == '/guarded' && env['HTTP_AUTHORIZATION'].nil?
        [401, {'www-authenticate' => 'Basic realm="r"', 'content-type' => 'text/plain'}, ['no']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']]
      end
    })
  }

  def xhr(path, user = nil)
    session.evaluate_script(<<~JS)
      (() => { const x = new XMLHttpRequest(); x.open('GET', #{path.to_json}, false#{", #{user.to_json}, 'p'" if user}); x.send(); return x.status; })()
    JS
  end

  it 'keeps only credentials a challenge was answered with' do
    session.visit '/'
    expect([xhr('/open', 'u'), xhr('/after'), xhr('/guarded', 'u'), xhr('/later')]).to eq([200, 200, 200, 200])

    basic = "Basic #{['u:p'].pack('m0')}"
    expect(seen.drop(1)).to eq([['/open', nil], ['/after', nil], ['/guarded', nil], ['/guarded', basic], ['/later', basic]])
  end
end
