require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "close the dialog", for `close()` and for a `dialog` method's submission: a dialog that is not open stays as it
# is; an open one loses `open` and modal-ness, takes the result as its returnValue unless the result is null, and
# queues the task that fires `close` (Chrome and Firefox both fire it after the script). A submission with the `dialog`
# method runs the whole submission algorithm up to it — validation, `submit`, the entry list and so `formdata`
# (Firefox; Chrome skips it) — and whichever way it is submitted, a submit button's value is the result, an image
# button's the selected coordinate. With no submit button, or one with no value, the result is null and the
# returnValue stays: the spec's explicit rule, which Chrome follows only for the valueless button and Firefox for
# neither (both set "").
RSpec.describe 'Closing a dialog' do
  let(:app) {
    lambda do |env|
      next [404, {}, ['']] unless env['PATH_INFO'] == '/'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <dialog id=a><form method=dialog id=fa><button id=ba value=yes>ok</button><input type=image id=ia alt=i></form></dialog>
          <dialog id=b><form id=fb><button formmethod=dialog id=bb>ok</button></form></dialog>
          <script>
            window.__log = [];
            const a = document.getElementById('a'), b = document.getElementById('b');
            a.addEventListener('close', (e) => __log.push('a close ' + e.isTrusted + ' ' + a.returnValue));
            b.addEventListener('close', (e) => __log.push('b close ' + b.returnValue));
            document.addEventListener('formdata', () => __log.push('formdata'), true);
            a.returnValue = 'prev';
            a.close();
            __log.push('not open ' + a.returnValue);
            a.showModal();
            a.close();
            __log.push('close() ' + a.returnValue + ' ' + (document.querySelector(':modal') === null));
            a.show();
            document.getElementById('fa').requestSubmit(document.getElementById('ba'));
            __log.push('button ' + a.returnValue + ' ' + a.open);
            a.show();
            document.getElementById('fa').requestSubmit(document.getElementById('ia'));
            __log.push('image ' + a.returnValue);
            a.returnValue = 'x';
            a.show();
            document.getElementById('fa').requestSubmit();
            __log.push('no button ' + a.returnValue);
            b.returnValue = 'keep';
            b.show();
            document.getElementById('bb').click();
            __log.push('valueless ' + b.returnValue);
          </script>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  it 'closes it as the spec says, the close event a task' do
    session.visit '/'
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(session.evaluate_script('window.__log')).to eq([
      'not open prev',
      'close() prev true',
      'formdata',
      'button yes false',
      'formdata',
      'image 0,0',
      'formdata',
      'no button x',
      'formdata',
      'valueless keep',
      'a close true x',
      'a close true x',
      'a close true x',
      'a close true x',
      'b close keep'
    ])
  end

  it "closes it on the user's click of a dialog-method form's button, nothing to navigate" do
    session.visit '/'
    session.execute_script(<<~JS)
      __log = [];
      document.getElementById('a').show();
    JS
    session.click_button 'ok', match: :first
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(session.evaluate_script('[document.getElementById("a").open, document.getElementById("a").returnValue, __log]')).to eq([
      false,
      'yes',
      [
        'formdata',
        'a close true yes'
      ]
    ])
    expect(session.current_path).to eq('/')
  end
end
