require 'capybara/simulated'
require_relative 'support/session_teardown'

# The structured clone of platform objects (HTML §2.7): a DOMException — any realm's — is [Serializable], made this
# realm's again with its name and message (a QuotaExceededError with its quota); a platform object that is not, a
# DataCloneError.
RSpec.describe 'Structured clone of platform objects' do
  let(:app) { ->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x<iframe srcdoc="y"></iframe>']] } }
  let(:session) { simulated_session(app) }

  it 'serializes a DOMException and refuses what is not serializable' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const c = structuredClone(new DOMException('m', 'AbortError'));
        const f = structuredClone(new frames[0].DOMException('n', 'NotFoundError'));
        const q = structuredClone(new QuotaExceededError('q', { quota: 5 }));
        const refused = [location, document.body.classList, new AbortController()]
          .map((v) => { try { structuredClone(v); return 'cloned'; } catch (e) { return e.name; } });
        return [[c instanceof DOMException, c.name, c.message, c.code], [f instanceof DOMException, f.code],
                [q instanceof QuotaExceededError, q.quota], refused];
      })()
    JS
    expect(got).to eq([[true, 'AbortError', 'm', 20], [true, 8], [true, 5], %w[DataCloneError DataCloneError DataCloneError]])
  end
end
