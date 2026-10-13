# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a dialog's show / request to close and a popover's showing may do, the engine's (dialogs.rs `dialogShowCheck`,
# popovers.rs `popoverCheck`). A `cancel` listener that takes the dialog out of its document destroys its close watcher,
# so the request to close it closes nothing (HTML "request to close"); and `popover` defines a state on an HTML element
# alone, so an SVG element with one is no popover for an invoker to show. Chrome: [true, "", false].
RSpec.describe 'Dialog and popover checks' do
  it 'leaves a dialog its cancel listener removed open, and an SVG popover unshown' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq([true, '', false])
      (() => {
        const d = document.body.appendChild(document.createElement('dialog'));
        d.addEventListener('cancel', () => d.remove());
        d.show();
        d.requestClose('rv');
        const svg = document.body.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
        svg.setAttribute('popover', '');
        svg.id = 'p';
        const invoker = document.body.appendChild(document.createElement('button'));
        invoker.setAttribute('popovertarget', 'p');
        invoker.click();
        return [d.open, d.returnValue, svg.matches(':popover-open')];
      })()
    JS
  end

  # …and one it re-inserts has a new close watcher, not the one the request began with: open, though no longer modal
  # (its removing steps), its returnValue unset. Chrome: [true, false, ""].
  it 'leaves a modal dialog its cancel listener re-inserted open' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq([true, false, ''])
      (() => {
        const d = document.body.appendChild(document.createElement('dialog'));
        d.addEventListener('cancel', () => { d.remove(); document.body.append(d); });
        d.showModal();
        d.requestClose('rv');
        return [d.open, d.matches(':modal'), d.returnValue];
      })()
    JS
  end

  # …and a request to close it from its own `cancel` listener returns at once, its watcher running its cancel action
  # already: one `cancel`, then the close. Chrome: [1, false].
  it 'fires one cancel where its listener requests the close again' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq([1, false])
      (() => {
        const d = document.body.appendChild(document.createElement('dialog'));
        let cancels = 0;
        d.addEventListener('cancel', () => { if (++cancels < 5) d.requestClose(); });
        d.showModal();
        d.requestClose();
        return [cancels, d.open];
      })()
    JS
  end

  # …the request it made giving the return value all the same, which the close then takes (HTML "request to close the
  # dialog" steps 5-7: the request close return value, set before the watcher's request to close returns). Chrome:
  # [1, false, "inner"].
  it 'closes with the return value the request made from its cancel listener gave' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq([1, false, 'inner'])
      (() => {
        const d = document.body.appendChild(document.createElement('dialog'));
        let cancels = 0;
        d.addEventListener('cancel', () => { if (++cancels < 5) d.requestClose('inner'); });
        d.showModal();
        d.requestClose('outer');
        return [cancels, d.open, d.returnValue];
      })()
    JS
  end

  # …but where the listener closed and reopened it, its new close watcher runs no cancel action yet: the request it then
  # makes fires a `cancel` of its own — the flag is the watcher's, not the dialog's. Chrome: [3, false, "r2"].
  it 'runs the cancel of a request a cancel listener made after reopening the dialog' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq([3, false, 'r2'])
      (() => {
        const d = document.body.appendChild(document.createElement('dialog'));
        let cancels = 0;
        d.addEventListener('cancel', () => {
          if (++cancels < 3) { d.close('c'); d.showModal(); d.requestClose('r' + cancels); }
        });
        d.showModal();
        d.requestClose('o');
        return [cancels, d.open, d.returnValue];
      })()
    JS
  end

  # …and a request that returns at once still ends what it enabled (step 8): a non-modal dialog — whose `closedby`
  # computes to none — that another dialog's `cancel` asked to close again is left open, its watcher no longer enabled.
  # Chrome: [true, "", false, "fromd"].
  it 'leaves open a dialog whose close watcher a nested request disabled' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq([true, '', false, 'fromd'])
      (() => {
        const d = document.body.appendChild(document.createElement('dialog'));
        const e = document.body.appendChild(document.createElement('dialog'));
        d.show();
        e.show();
        d.addEventListener('cancel', () => e.requestClose('fromd'));
        e.addEventListener('cancel', () => d.requestClose('frome'));
        d.requestClose('dd');
        return [d.open, d.returnValue, e.open, e.returnValue];
      })()
    JS
  end
end
