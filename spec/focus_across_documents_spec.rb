require 'capybara/simulated'
require_relative 'support/session_teardown'

# Autofocus and a dialog's focus across documents and realms (spec/fixtures/focus_pages, each printing what it saw into
# `#out`), every figure Chrome's (chromedriver, 2026-10-10): a dialog gives focus back only to an element still in a
# document (d6), and does so for a dialog one realm made and another's document holds (d7); a removed frame's autofocus
# candidate leaves the top-level document's its turn (a4), one moved into a frame keeps its place (a6), and a document
# at a fragment anywhere up the navigables passes its candidates over (a3).
RSpec.describe 'Focus across documents' do
  let(:dir) { File.expand_path('fixtures/focus_pages', __dir__) }
  let(:session) {
    simulated_session(lambda {|env|
      path = File.join(dir, File.basename(env['PATH_INFO']))
      File.file?(path) ? [200, {'content-type' => 'text/html; charset=utf-8'}, [File.read(path)]] : [404, {}, ['']]
    })
  }

  {
    'd6' => 'db db db',
    'd7' => 'f:q f:db f:q f:db f:q',
    'a4' => 'top',
    'a6' => 'f/i',
    'a3' => 'BODY/BODY/BODY tgt=true'
  }.each do |page, want|
    it "#{page}: #{want}" do
      session.visit "/#{page}.html"
      expect(session).to have_css('#out', text: 'done')
      expect(session.find('#out').text).to eq("#{want} done")
    end
  end
end
