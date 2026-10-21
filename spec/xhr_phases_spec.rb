# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# XMLHttpRequest's events as the engine sequences them (xhr_state.rs `Plan`): the request error steps fire each of their
# events whatever a handler of one does — a network error's as an abort's (XHR "handle errors") — an open() unsets the
# upload listener flag, so the send before it fires its upload nothing more, and the upload's load and loadend carry its
# own body's size though a handler sends another.
RSpec.describe 'XHR event phases' do
  include PollUntil

  let(:app) {
    lambda do |env|
      raise 'boom' if env['PATH_INFO'] == '/boom'
      [200, {'content-type' => 'text/plain'}, [env['PATH_INFO'] == '/' ? '<!doctype html><body>' : 'ok']]
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  def run(js)
    session.execute_script("window.__log = []; window.__done = false; #{js}")
    poll_until { session.evaluate_script('__done') }
    session.evaluate_script('__log')
  end

  it 'fires every request error event of a network error, a readystatechange handler opening it again' do
    got = run(<<~JS)
      const x = new XMLHttpRequest();
      x.open('POST', '/boom');
      let opened = false;
      x.onreadystatechange = () => { if (x.readyState === 4 && !opened) { opened = true; x.open('GET', '/ok'); } };
      for (const t of ['error', 'loadend']) x.addEventListener(t, () => { __log.push(t); if (t === 'loadend') __done = true; });
      x.upload.onerror = () => __log.push('upload error');
      x.send('abc');
    JS
    expect(got).to eq(%w[error loadend])
  end

  it 'fires the upload of an aborted send nothing once a handler opens the request again' do
    got = run(<<~JS)
      const x = new XMLHttpRequest();
      x.open('POST', '/ok');
      x.upload.onabort = () => __log.push('upload abort');
      x.upload.onloadend = () => __log.push('upload loadend');
      x.onreadystatechange = () => { if (x.readyState === 4) x.open('POST', '/ok'); };
      x.onloadend = () => { __log.push('loadend'); __done = true; };
      x.send('abc');
      x.abort();
    JS
    expect(got).to eq(%w[loadend])
  end

  it "reports an upload's own size at its load though a handler sends another body" do
    got = run(<<~JS)
      const x = new XMLHttpRequest();
      x.open('POST', '/ok');
      let again = false;
      x.upload.onprogress = () => { if (!again) { again = true; x.open('POST', '/ok'); x.send('abcdefghijklmnop'); } };
      x.upload.onload = (e) => __log.push('load ' + e.loaded + '/' + e.total);
      x.onloadend = () => { __done = true; };
      x.send('abcdef');
    JS
    expect(got.first).to eq('load 6/6')
  end
end
