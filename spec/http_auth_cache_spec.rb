# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# Credentials a request carries (XMLHttpRequest open()'s user and password, a URL's userinfo) answer a 401 challenge;
# only one answered — accepted — is kept for the origin and sent ahead of the next request. One no server ever asked
# for is sent with nothing later (Chrome, measured: the next request carries no Authorization).
RSpec.describe 'HTTP authentication entries' do
  let(:seen) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_AUTHORIZATION']]
      next [302, {'location' => 'http://other.example.com/guarded'}, ['']] if env['PATH_INFO'] == '/away'

      if env['PATH_INFO'] == '/guarded' && env['HTTP_AUTHORIZATION'].nil?
        [401, {'www-authenticate' => 'Basic realm="r"', 'content-type' => 'text/plain', 'access-control-allow-origin' => '*'}, ['no']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']]
      end
    })
  }

  def xhr(path, user = nil, with_credentials: false)
    session.evaluate_script(<<~JS)
      (() => {
        const x = new XMLHttpRequest();
        x.open('GET', #{path.to_json}, false#{", #{user.to_json}, 'p'" if user});
        x.withCredentials = #{with_credentials};
        try { x.send(); } catch (e) { return e.name; }
        return x.status;
      })()
    JS
  end

  it 'keeps only credentials a challenge was answered with' do
    session.visit '/'
    expect([xhr('/open', 'u'), xhr('/after'), xhr('/guarded', 'u'), xhr('/later')]).to eq([200, 200, 200, 200])

    basic = "Basic #{['u:p'].pack('m0')}"
    expect(seen.drop(1)).to eq([['/open', nil], ['/after', nil], ['/guarded', nil], ['/guarded', basic], ['/later', basic]])
  end

  # (…but a CORS request off its origin prompts for none: Fetch answers a 401 only where the response tainting is not
  # "cors", so the challenge reaches script as it is)
  # (…the other origin served in-process)
  it 'answers no challenge to a CORS request of another origin', :every_host_local do
    session.visit '/'
    expect(xhr('http://other.example.com/guarded', 'u')).to eq(401)
    expect(xhr('http://other.example.com/guarded', 'u', with_credentials: true)).to eq('NetworkError')
    # (…and a same-origin request led off its origin, whatever its credentials mode: its response tainting is "cors")
    expect(xhr('/away', 'u')).to eq(401)
    expect(seen.drop(1)).to eq([['/guarded', nil], ['/guarded', nil], ['/away', nil], ['/guarded', nil]])
  end
end
