# frozen_string_literal: true

require_relative 'support/wpt_runner'

# The WPT files whose subtests also assert RFC 6265bis's Lax by default (wpt_out_of_scope.yml: the driver follows
# draft-ietf-httpbis-layered-cookies, where a cookie of no SameSite attribute is "unset" and goes cross-site) hold the
# Strict, Lax and None cookies to their contexts in the same subtests, which the gate, listing those subtests, no
# longer guards. Run here with the assertions about an "unset" cookie dropped, every subtest must pass: cookie-helper's
# `samesite_unspecified`, and multiple-samesite-attributes' cookies whose last SameSite attribute is of no known value —
# as served, `SameSite=Unsupported` alone, setSameSiteMultiAttribute.py's dict keeping the last of its duplicate keys.
RSpec.describe 'the SameSite WPT files, their unset cookie aside', :wpt do
  files = %w[
    cookies/samesite/fetch.https.html
    cookies/samesite/form-post-blank-reload.https.html
    cookies/samesite/form-post-blank.https.html
    cookies/samesite/iframe-reload.https.html
    cookies/samesite/iframe.https.html
    cookies/samesite/img.https.html
    cookies/samesite/multiple-samesite-attributes.https.html
    service-workers/service-worker/same-site-cookies.https.html
  ].freeze

  # (…each served file's text as its edit makes it: the helper's assertions of the cookie, and a page's own — an element
  # `expectedStatus == SameSiteStatus.CROSS_SITE ? assert_cookie_absent(…) : assert_cookie_present(…)` of its list)
  unset = %w[
    samesite_unspecified
    samesite_unsupported
    samesite_none_unsupported
    samesite_lax_unsupported
    samesite_strict_unsupported
  ].freeze
  drop_pair = lambda {|text|
    unset.reduce(text) {|t, name|
      t.gsub(/,\s*expectedStatus == SameSiteStatus\.CROSS_SITE \?\s*assert_cookie_absent\(target, "#{name}", value\) :\s*assert_cookie_present\(target, "#{name}", value\)/, '')
    }
  }
  edits = {
    '/cookies/resources/cookie-helper.sub.js'                   => ->(text) { text.gsub(/^.*cookies\["samesite_unspecified"\].*\n/, '') },
    '/cookies/samesite/img.https.html'                          => drop_pair,
    '/cookies/samesite/multiple-samesite-attributes.https.html' => drop_pair
  }.freeze

  # (…through a session of its own on an app that edits them, the gate's own app and session left as they were for the
  # files after it in this process)
  around do |example|
    inner   = WptRunner.app
    session = WptRunner.instance_variable_get(:@session)
    WptRunner.instance_variable_set(:@session, nil)
    WptRunner.instance_variable_set(:@app, lambda {|env|
      status, headers, body = inner.call(env)
      next [status, headers, body] unless (edit = edits[env['PATH_INFO']])

      text = +''
      body.each {|chunk| text << chunk }
      body.close if body.respond_to?(:close)
      [status, headers.reject {|k, _| k.to_s.casecmp?('content-length') }, [edit.(text)]]
    })
    example.run
  ensure
    WptRunner.drop_session!
    WptRunner.instance_variable_set(:@app, inner)
    WptRunner.instance_variable_set(:@session, session)
  end

  it 'passes every Strict, Lax and None assertion' do
    results = files.to_h {|rel|
      r = WptRunner.run(rel)
      [rel, [r[:completed], (r[:tests] || []).size.positive?, (r[:tests] || []).reject {|t| t['status'].to_i.zero? }.map {|t| "#{t['name']}: #{t['message']}" }]]
    }
    expect(results).to eq(files.to_h {|rel| [rel, [true, true, []]] })
  end
end
