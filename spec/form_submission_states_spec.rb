# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# How a form submits is the engine's (form_entries.rs `formSubmission`): its `method` and `enctype` are enumerated
# attributes — ASCII case-insensitive, an invalid value GET and urlencoded — a submitter's `formmethod` / `formenctype`
# over the form's, and with no `target` the document's `<base target>` names the navigable it submits into.
RSpec.describe 'Form submission states' do
  def app(received, body)
    lambda {|env|
      req = Rack::Request.new(env)
      if req.path == '/'
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
      else
        received << [req.request_method, req.path, env['CONTENT_TYPE'], env['QUERY_STRING']]
        [200, {'content-type' => 'text/html'}, ['<p>ok</p>']]
      end
    }
  end

  forms = {
    'an invalid method'       => ['<form method=posted action=/a><input name=q value=1><button>go</button></form>', ['GET', '/a', nil, 'q=1']],
    'an invalid enctype'      => [
      '<form method=POST enctype=bogus action=/b><input name=q value=1><button>go</button></form>',
      ['POST', '/b', 'application/x-www-form-urlencoded', '']
    ],
    'an enctype in uppercase' => [
      '<form method=post enctype=TEXT/PLAIN action=/c><input name=q value=1><button>go</button></form>',
      ['POST', '/c', 'text/plain', '']
    ],
    'a formmethod'            => ['<form method=post action=/d><input name=q value=1><button formmethod=get>go</button></form>', ['GET', '/d', nil, 'q=1']]
  }
  forms.each do |what, (form, request)|
    it "submits #{what} as its state says" do
      received = []
      s = simulated_session(app(received, form))
      s.visit '/'
      s.click_on 'go'
      expect(received.first).to eq(request)
    end
  end

  it 'submits into the frame its document’s <base target> names' do
    received = []
    s = simulated_session(app(received, '<base target=f><form action=/e><button>go</button></form><iframe name=f></iframe>'))
    s.visit '/'
    s.click_on 'go'
    s.within_frame('f') { expect(s).to have_text('ok') }
    expect([received.first&.first(2), s.current_path]).to eq([%w[GET /e], '/'])
  end
end
