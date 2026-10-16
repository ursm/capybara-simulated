require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's document navigating itself (its `location`) navigates the container's navigable — HTML "navigate" — which
# writes none of the container's attributes: its `src` stays what the page set, whatever the URL's scheme.
RSpec.describe 'a nested document navigating itself' do
  include PollUntil

  def session
    pages = {
      '/'  => '<!DOCTYPE html><meta charset="utf-8"><body><iframe id=f src="/o"></iframe>',
      '/o' => '<!DOCTYPE html><meta charset="utf-8"><p>o'
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
    s.visit '/'
    s
  end

  it "keeps the container's src for a blob: URL, the bytes taken before the page revoked it" do
    s = session
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument?.body?.textContent') == 'o' }
    s.execute_script(<<~JS)
      const f = document.getElementById('f');
      window.R = [];
      new MutationObserver((records) => R.push(...records.map((r) => r.attributeName))).observe(f, {attributes: true});
      const w = f.contentWindow;
      const url = w.URL.createObjectURL(new w.Blob(['<p>b'], {type: 'text/html'}));
      w.location = url;
      w.URL.revokeObjectURL(url);
    JS
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument.body?.textContent') == 'b' }
    expect(s.evaluate_script('[document.getElementById("f").getAttribute("src"), R]')).to eq(['/o', []])
  end
end
