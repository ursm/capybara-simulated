# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An `<img>` whose server delays its response (a WPT handler's virtualized `time.sleep`: X-Csim-Server-Delay-Ms) arrives
# that many virtual ms later — and, like every image fetch, delays the document's load event until it does.
RSpec.describe 'an image its server delays' do
  include PollUntil

  png = File.binread(File.join(__dir__, 'wpt/images/anim-gr.png'))
  delayed_png = [200, {'content-type' => 'image/png', 'x-csim-server-delay-ms' => '500'}, [png]]

  it 'holds the window load event until the image arrives' do
    app = lambda {|env|
      next delayed_png if env['PATH_INFO'] == '/i.png'

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><body><img id="i" src="/i.png">
        <script>
          window.log = [];
          const start = performance.now();
          i.onload = () => log.push(['img', Math.round(performance.now() - start)]);
          addEventListener('load', () => log.push(['window', i.complete, i.naturalWidth]));
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 2 }
    img, win = session.evaluate_script('log')
    expect(img[0]).to eq('img')
    expect(img[1]).to be >= 500
    expect(win).to eq(['window', true, 100])
  end

  it 'delays the load event no more once a later load supersedes it' do
    app = lambda {|env|
      case env['PATH_INFO']
      when '/i.png'    then delayed_png
      when '/fast.png' then [200, {'content-type' => 'image/png'}, [png]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><body><img id="i" src="/i.png">
          <script>
            window.log = [];
            const start = performance.now();
            i.src = '/fast.png';
            addEventListener('load', () => log.push(['window', i.complete, Math.round(performance.now() - start)]));
          </script>
        HTML
      end
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 1 }
    type, complete, at = session.evaluate_script('log[0]')
    expect([type, complete]).to eq(['window', true])
    expect(at).to be < 500
  end

  it 'pins no bitmap when its page navigates away before it arrives' do
    app = lambda {|env|
      case env['PATH_INFO']
      when '/i.png' then delayed_png
      when '/next'  then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p>next']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><body>
          <script>
            onload = () => {
              const i = new Image();
              i.onload = () => sessionStorage.landed = 'yes';
              i.src = '/i.png';
              setTimeout(() => location.href = '/next', 100);
            };
          </script>
        HTML
      end
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('location.pathname') == '/next' }
    expect(session.evaluate_script('sessionStorage.landed || null')).to be_nil
    expect(session.driver.browser.instance_variable_get(:@transfer_buffers)).to be_empty
  end

  # A frame's images delay its document's load event as the page's do, and its document's load delays its container's
  # and so the page's: the image, then the frame's window, then the iframe, then the page (HTML "delay the load event").
  it "delays a frame's load, its container's and the page's until the frame's image arrives" do
    frame = '<!DOCTYPE html><meta charset="utf-8"><img id="i" src="/i.png"><script>' \
            'onload = () => top.log.push("frame " + i.complete + " " + i.naturalWidth); i.onload = () => top.log.push("image")</script>'
    app = lambda {|env|
      next delayed_png if env['PATH_INFO'] == '/i.png'
      next [200, {'content-type' => 'text/html'}, [frame]] if env['PATH_INFO'] == '/f'

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><script>window.log = []</script>
        <iframe src="/f" onload="log.push('iframe')"></iframe>
        <script>addEventListener('load', () => log.push('page'))</script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 4 }
    expect(session.evaluate_script('log')).to eq(['image', 'frame true 100', 'iframe', 'page'])
  end
end
