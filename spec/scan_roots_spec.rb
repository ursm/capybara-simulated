# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What the engine finds of a tree for a scan — the document's stylesheet owners, a form's form-associated custom
# elements — it finds among the root's descendants, so the scan starts at the tree's root: a document, whose document
# element is one of them (a `<style>` that is it applies — Chrome `rgb(1, 2, 3)`), or a shadow root, where a form whose
# id changes reaches the custom elements its `form` attribute names (Chrome: `formAssociatedCallback(b)`).
RSpec.describe 'a scan of a tree' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/' }

  it 'takes a document element that owns a stylesheet' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const style = document.createElement('style');
        style.textContent = 'style { display: block; color: rgb(1, 2, 3) }';
        document.replaceChild(style, document.documentElement);
        return getComputedStyle(style).color;
      })()
    JS
    expect(got).to eq('rgb(1, 2, 3)')
  end

  it "resets the form-associated elements of a shadow tree whose form's id changes" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const log = [];
        customElements.define('my-face', class extends HTMLElement {
          static formAssociated = true;
          constructor() { super(); this.internals = this.attachInternals(); }
          formAssociatedCallback(form) { log.push('fac:' + (form && form.id)); }
        });
        const root = document.body.appendChild(document.createElement('div')).attachShadow({mode: 'open'});
        root.innerHTML = '<form id=a></form><my-face form=b></my-face>';
        root.querySelector('form').id = 'b';
        return log.concat(root.querySelector('my-face').internals.form.id);
      })()
    JS
    expect(got).to eq(['fac:b', 'b'])
  end
end
