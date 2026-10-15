require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's base URL (HTML §2.4.1, url_ops.rs `document_base_url`): its first `<base>` with an `href`, that `href`
# parsed against the fallback base URL in the document's encoding — the fallback where it is a `data:` or a
# `javascript:` URL. Chrome 155 ignores both such bases; it parses the query in UTF-8 (`?q=%C3%A9`) where the spec and
# Firefox take the document's windows-1252 (`?q=%E9`).
RSpec.describe 'the document base URL' do
  def base_uri(page)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/p/page.html'
    s.evaluate_script('document.baseURI')
  end

  it 'resolves the first base href against the document URL' do
    expect(base_uri('<!DOCTYPE html><meta charset=utf-8><base href="/b/c/"><base href="/ignored/">')).to eq('http://www.example.com/b/c/')
  end

  it 'falls back to the document URL for a data: or javascript: base' do
    expect(base_uri('<!DOCTYPE html><meta charset=utf-8><base href="data:text/html,x">')).to eq('http://www.example.com/p/page.html')
    expect(base_uri('<!DOCTYPE html><meta charset=utf-8><base href="javascript:void 0">')).to eq('http://www.example.com/p/page.html')
  end

  it "parses the base href's query in the document's encoding" do
    expect(base_uri("<!DOCTYPE html><meta charset=windows-1252><base href=\"/b/?q=\xE9\">".b)).to eq('http://www.example.com/b/?q=%E9')
  end

  # An element's resource is fetched from its URL encoding-parsed against the document: the style sheet the cascade
  # applies and the `<link>`'s `.sheet` are one fetch, of one URL, its query in the document's windows-1252.
  it "fetches a link's style sheet once, by the URL its sheet reports" do
    page = "<!DOCTYPE html><meta charset=windows-1252><link rel=stylesheet href=\"/s.css?q=\xE9\"><p>x</p>".b
    queries = []
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/html'}, [page]] if env['PATH_INFO'] == '/'
      queries << env['QUERY_STRING']
      [200, {'content-type' => 'text/css'}, ['p { color: rgb(1, 2, 3) }']]
    })
    s.visit '/'
    expect(s.evaluate_script("[getComputedStyle(document.querySelector('p')).color, document.styleSheets[0].href]")).to eq(
      ['rgb(1, 2, 3)', 'http://www.example.com/s.css?q=%E9']
    )
    expect(queries.uniq).to eq(['q=%E9'])
  end
end
