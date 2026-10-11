# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A task the platform queues is named by a key no other realm's task has (timers.rs `TaskKeys`): one cancelled from
# another realm's code — a frame-made popover, adopted into the page, hidden through the frame's prototype, cancelling
# the toggle task the page's realm queued — is the one it names, not a task of the frame's that happens to share a
# number: the frame's `AbortSignal.timeout` still fires, and the popover's show-then-hide is one `toggle`.
RSpec.describe 'a platform task cancelled from another realm' do
  let(:page_html) { "<!DOCTYPE html><meta charset=utf-8><body><button id=b popovertarget=p>b</button><iframe id=f srcdoc='<p>f</p>'></iframe>" }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  it 'is the task it names' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      const fw = frames[0];
      window.fsig = fw.AbortSignal.timeout(10);
      fsig.onabort = () => log.push('timeout');
      const p = fw.document.createElement('div');
      p.id = 'p';
      p.popover = 'manual';
      p.ontoggle = (e) => log.push(e.oldState + '>' + e.newState);
      document.body.append(p);
      document.getElementById('b').click();
      p.hidePopover();
    JS
    10.times { session.execute_script('__drainTimers(50)') }
    expect(session.evaluate_script('[log, fsig.aborted]')).to eq([['closed>closed', 'timeout'], true])
  end
end
