# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame entered with `within_frame` navigates as any frame does: a controlling service worker's fetch event sees its
# navigation request — a link's GET, a form's POST with its body — and what it answers with makes the frame's document
# (Service Workers "Handle Fetch"; HTML "create navigation params by fetching").
RSpec.describe 'Service Worker entered frame navigation' do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname !== '/scope/answered') return;
        e.respondWith(e.request.text().then(body => new Response(
          `<!DOCTYPE html><meta charset=utf-8><p id=a>${e.request.mode} ${e.request.method} ${body}</p>`,
          {headers: {'content-type': 'text/html'}}
        )));
      });
    JS
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <a id=l href="/scope/answered">l</a>
      <form method=post action="/scope/answered"><input name=q value=v><button id=b>b</button></form>
    HTML
    Rack::Builder.new {
      run lambda {|env|
        case env['PATH_INFO']
        when '/'                then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>main']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, [page]]
        else [404, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><p id=a>network']]
        end
      }
    }.to_app
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  def controlled_frame_session
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => { globalThis.__ready = true; };
        document.body.appendChild(f);
      });
    JS
    poll_until { session.evaluate_script('globalThis.__ready === true') }
    session
  end

  {
    'a link'         => [proc { click_link 'l' }, 'navigate GET '],
    'a form\'s POST' => [proc { click_button 'b' }, 'navigate POST q=v']
  }.each do |name, (act, answer)|
    it "answers #{name} followed in an entered frame" do
      session = controlled_frame_session
      session.within_frame(0) do
        session.instance_exec(&act)
        expect(session.find('#a').text).to eq(answer.strip)
      end
    end
  end
end
