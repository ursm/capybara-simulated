require 'capybara/simulated'
require_relative 'support/session_teardown'

# The structured clone of platform objects (HTML §2.7): a DOMException — any realm's — is [Serializable], made this
# realm's again with its name and message (a QuotaExceededError with its quota); a platform object that is not, a
# DataCloneError.
RSpec.describe 'Structured clone of platform objects' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/echo.js'
        [200, {'content-type' => 'text/javascript'}, ["onmessage = (e) => postMessage([e.data, new QuotaExceededError('wq', { quota: 3, requested: 4 })]);"]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x<iframe srcdoc="y"></iframe>']]
      end
    end
  }
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

  it "carries a DOMException and an Error of any realm to a worker and back as the clone does" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], w = new Worker('/echo.js');
      w.onmessage = (e) => {
        const [[f, t, q], back] = e.data;
        done([[f instanceof DOMException, f.name, f.message, f.code], [t instanceof TypeError, t.message],
              [q instanceof QuotaExceededError, q.quota, q.requested], [back instanceof QuotaExceededError, back.quota, back.requested]]);
      };
      w.postMessage([new frames[0].DOMException('fm', 'NotFoundError'), new frames[0].TypeError('t'),
                     new QuotaExceededError('qm', { quota: 5, requested: 6 })]);
    JS
    expect(got).to eq([[true, 'NotFoundError', 'fm', 8], [true, 't'], [true, 5, 6], [true, 3, 4]])
  end
end
