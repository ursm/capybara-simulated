# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A form a frame's document submits navigates the navigable its target chooses, routed by the engine
# (navigation_plan.rs `RoutedSubmissions`) as the task ends: by that navigable, whatever document it has by then; none
# of a frame gone since (HTML "plan to navigate" queues it on a document no longer fully active — Firefox); a frame's own
# navigation replaced only where it targets that frame; and a javascript: URL frame's ahead of its string result
# (Chrome and Firefox: the form's response).
RSpec.describe 'a frame\'s form submission' do
  include PollUntil

  let(:hits) { [] }
  let(:session) do
    seen = hits
    js_frame = '<iframe src="javascript:(function(){var f=document.createElement(\'form\');f.method=\'post\';' \
               'f.action=\'/jspost\';document.body.appendChild(f);f.submit();return \'<p>js</p>\'})()"></iframe>'
    js_other = '<iframe name=y src=/y0></iframe><iframe src="javascript:(function(){var f=document.createElement(\'form\');' \
               'f.method=\'post\';f.target=\'y\';f.action=\'/jsy\';document.body.appendChild(f);f.submit();' \
               'return \'<p>js</p>\'})()"></iframe>'
    simulated_session(lambda {|env|
      seen << "#{env['REQUEST_METHOD']} #{env['PATH_INFO']}"
      form = ->(name, target, method = 'get') { %(<form id=f action="/#{name}" method=#{method} target="#{target}"><input name=q value=1></form>) }
      body = case env['PATH_INFO']
             when '/two'  then '<iframe name=x src=/fx></iframe><iframe name=y src=/fy></iframe><iframe name=t src=/t0></iframe>'
             when '/fx'   then form.('fromx', 't')
             when '/fy'   then form.('fromy', 't')
             when '/gone' then '<iframe id=xf name=x src=/gx></iframe><iframe name=y src=/y0></iframe>'
             when '/gx'   then form.('posted', 'y', 'post')
             when '/own'  then '<iframe name=x src=/gx></iframe><iframe name=y src=/y0></iframe>'
             when '/js'   then js_frame
             when '/jsy0' then js_other
             else "<p>#{env['PATH_INFO'].delete_prefix('/')}</p>"
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
  end
  let(:text) { ->(i) { session.evaluate_script("frames[#{i}].document.body?.textContent") } }

  it 'navigates the frame it chose with the later of two, whatever document the earlier gave it' do
    session.visit '/two'
    poll_until { text.(2) == 't0' }
    session.execute_script('frames[1].f.submit(); frames[0].f.submit()')
    expect(poll_until { text.(2) == 'fromx' && text.(2) }).to eq('fromx')
  end

  it 'sends none of a frame removed after it submitted' do
    session.visit '/gone'
    poll_until { text.(1) == 'y0' }
    session.execute_script("const w = frames[0]; w.f.submit(); document.getElementById('xf').remove()")
    session.evaluate_script('1')
    expect(hits).not_to include('POST /posted')
    expect(text.(0)).to eq('y0')
  end

  it "keeps the frame's own navigation where it submits to another" do
    session.visit '/own'
    poll_until { text.(1) == 'y0' }
    session.execute_script("frames[0].location = '/z'; frames[0].f.submit()")
    poll_until { [text.(0), text.(1)] == %w[z posted] }
    expect([text.(0), text.(1)]).to eq(%w[z posted])
  end

  it "navigates a javascript: URL frame to the response of a form its script submitted" do
    session.visit '/js'
    poll_until { text.(0) == 'jspost' }
    expect(text.(0)).to eq('jspost')
    expect(hits).to include('POST /jspost')
  end

  # …its result its document all the same where the form goes to another frame (Chrome).
  it 'keeps a javascript: URL frame\'s result where the form it submitted goes to another frame' do
    session.visit '/jsy0'
    expect(poll_until { [text.(0), text.(1)] == %w[jsy js] && [text.(0), text.(1)] }).to eq(%w[jsy js])
    expect(hits).to include('POST /jsy')
  end
end
