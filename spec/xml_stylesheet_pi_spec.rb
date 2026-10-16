# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An `<?xml-stylesheet?>` in an XML document's prolog associates a style sheet with it (Associating Style Sheets with
# XML documents §2, CSSOM §6.3.2): one of the document's sheets — in `document.styleSheets`, in tree order — that its
# cascade takes, chosen again as its data changes and let go of as it is removed (sheet_owners.rs `associates_sheet`).
RSpec.describe 'an xml-stylesheet processing instruction' do
  def session
    routes = {
      '/x'     => ['application/xhtml+xml', '<?xml version="1.0"?><?xml-stylesheet href="/a.css" type="text/css"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div id="t">x</div></body></html>'],
      '/a.css' => ['text/css', '#t { color: rgb(5, 5, 5) }'],
      '/b.css' => ['text/css', '#t { color: rgb(7, 7, 7) }']
    }
    s = simulated_session(->(env) { (r = routes[env['PATH_INFO']]) ? [200, {'content-type' => r[0]}, [r[1]]] : [404, {}, ['']] })
    s.visit '/x'
    s
  end

  it "styles its document, as its data and its place say" do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq(['rgb(5, 5, 5)', true, 'rgb(7, 7, 7)', 'rgb(0, 0, 0)', 0, 'rgb(7, 7, 7)'])
      (() => {
        const pi = document.firstChild, t = document.getElementById('t'), color = () => getComputedStyle(t).color;
        const out = [color(), document.styleSheets[0] === pi.sheet];
        pi.data = 'href="/b.css" type="text/css"';
        out.push(color());
        document.removeChild(pi);
        out.push(color(), document.styleSheets.length);
        document.insertBefore(pi, document.documentElement);
        out.push(color());
        return out;
      })()
    JS
  end
end
