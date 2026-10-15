require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's `<meta name="referrer">` (url_ops.rs `meta_referrer_policy`): its content ASCII-lowercased, a legacy
# keyword mapped (`never` → no-referrer), the last valid one in tree order — what a frame's navigation of itself (a link
# followed in it) sends its Referer by.
RSpec.describe 'the meta referrer policy' do
  it "sets a frame's navigation Referer by its last valid meta" do
    referers = {}
    s = simulated_session(->(env) {
      referers[env['PATH_INFO']] = env['HTTP_REFERER']
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe src="/frame"></iframe>']]
      when '/frame'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8"><meta name="Referrer" content="bogus"><meta name="REFERRER" content="NEVER">
          <a id="go" href="/next">go</a>
        HTML
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id="done">next</p>']]
      end
    })
    s.visit '/'
    s.within_frame(0) do
      s.click_link 'go'
      expect(s).to have_css('#done')
    end
    expect(referers['/next']).to be_nil
  end
end
