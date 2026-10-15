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
end
