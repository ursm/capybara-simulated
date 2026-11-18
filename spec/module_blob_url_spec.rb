# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A module script's URL is resolved as "prepare the script element" runs, and a blob: one's blob is the one its blob URL
# entry named then: a revoke right after the insertion changes nothing (Chrome and Firefox run it, csim-bench r13
# `rv_blob_rev`).
RSpec.describe 'a module script of a blob: URL' do
  it 'runs one inserted and revoked at once' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>t</title>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const u = URL.createObjectURL(new Blob(['document.title += "m"'], { type: 'text/javascript' }));
      const s = document.createElement('script');
      s.type = 'module';
      s.src = u;
      s.onerror = () => { document.title += 'e'; };
      document.head.append(s);
      URL.revokeObjectURL(u);
    JS
    expect(s).to have_title('tm')
  end
end
