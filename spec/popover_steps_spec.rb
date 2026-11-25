# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The popover and dialog algorithms (popovers.rs, dialogs.rs, close_watchers.rs) against Chrome and Firefox, measured
# 2026-11-25 with the probe pages under ~/.local/share/csim-bench/pop11/p (Chrome 15x headless `--dump-dom`, Firefox
# headless `--screenshot`); where Firefox's headless window takes no focus, Chrome's figure alone.
RSpec.describe 'Popover and dialog steps' do
  def session_with(body)
    page = "<!DOCTYPE html><meta charset=utf-8><body>#{body}"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
  end

  # HTML "popover focusing steps": a popover shown focuses its autofocus delegate, or itself where it carries
  # `autofocus` — nothing for neither — and the first popover of a stack keeps the element focused before it, which
  # hiding it with focus inside gives focus back to; a popover the next auto one hides keeps focus (no focus moved for
  # it). Chrome and Firefox: ["a1", "b0", "b0", "p3", "b0", "r1", "b0"].
  it 'runs the popover focusing steps and gives focus back as one hides' do
    s = session_with(<<~HTML)
      <button id=b0>b0</button>
      <div popover id=p1><button id=c1>c1</button><button id=a1 autofocus>a1</button></div>
      <div popover id=p2><button id=c2>c2</button></div>
      <div popover id=p3 autofocus tabindex=-1>p3</div>
      <div popover id=r1 autofocus tabindex=0>r1</div>
      <div popover id=r2>r2</div>
    HTML
    expect(s.evaluate_script(<<~'JS')).to eq(%w[a1 b0 b0 p3 b0 r1 b0])
      (() => {
        const ae = () => document.activeElement.id;
        const out = [];
        b0.focus(); p1.showPopover(); out.push(ae()); p1.hidePopover(); out.push(ae());
        b0.focus(); p2.showPopover(); out.push(ae()); p2.hidePopover();
        b0.focus(); p3.showPopover(); out.push(ae()); p3.hidePopover(); out.push(ae());
        b0.focus(); r1.showPopover(); r2.showPopover(); out.push(ae()); r2.hidePopover();
        b0.focus(); p1.showPopover(); b0.focus(); p1.hidePopover(); out.push(ae());
        return out;
      })()
    JS
  end

  # A document's "showing popover" flag and "hiding popover nesting count": no popover shown during another's show or
  # hide — a listener's showPopover() an InvalidStateError — though one may hide, and a dialog show. Chrome and Firefox:
  # ["InvalidStateError false", "InvalidStateError false true", "hid false true", "shown true"].
  it 'refuses to show a popover during another popover’s show or hide' do
    s = session_with('<div popover id=q1>q1<div popover id=q2>q2</div></div><div popover id=r2>r2</div><dialog id=d>d</dialog>')
    expect(s.evaluate_script(<<~'JS')).to eq(['InvalidStateError false', 'InvalidStateError false true', 'hid false true', 'shown true'])
      (() => {
        const out = [];
        const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } };
        q1.showPopover();
        let r;
        q1.onbeforetoggle = (e) => { if (e.newState === 'closed') r = attempt(() => q2.showPopover()); };
        q1.hidePopover();
        out.push(`${r} ${q2.matches(':popover-open')}`);
        q1.onbeforetoggle = (e) => { if (e.newState === 'open') r = attempt(() => r2.showPopover()); };
        q1.showPopover();
        out.push(`${r} ${r2.matches(':popover-open')} ${q1.matches(':popover-open')}`);
        q1.hidePopover();
        r2.showPopover();
        q1.onbeforetoggle = (e) => { if (e.newState === 'open') r = attempt(() => r2.hidePopover()) === 'ok' ? 'hid' : 'threw'; };
        q1.showPopover();
        out.push(`${r} ${r2.matches(':popover-open')} ${q1.matches(':popover-open')}`);
        q1.onbeforetoggle = (e) => { if (e.newState === 'closed') r = attempt(() => d.show()) === 'ok' ? 'shown' : 'threw'; };
        q1.hidePopover();
        out.push(`${r} ${d.open}`);
        return out;
      })()
    JS
  end

  # A showing popover whose `popover` attribute is removed is hidden with its events — whatwg/html#9367 (open): the spec's
  # "check popover validity" would stop the hide and leave it showing — and one its `beforetoggle` listener gives another
  # state hides all the same. Chrome and Firefox:
  # ["bt open auto", "bt closed null", "false", "bt open", "bt closed", "false manual"].
  it 'hides a popover whose attribute is removed, firing its events' do
    s = session_with('<div popover=auto id=a>a</div><div popover=auto id=b>b</div>')
    expect(s.evaluate_script(<<~'JS')).to eq(['bt open auto', 'bt closed null', 'false', 'bt open', 'bt closed', 'false manual'])
      (() => {
        const out = [];
        a.addEventListener('beforetoggle', (e) => out.push(`bt ${e.newState} ${a.getAttribute('popover')}`));
        a.showPopover();
        a.removeAttribute('popover');
        out.push(String(a.matches(':popover-open')));
        b.addEventListener('beforetoggle', (e) => { out.push(`bt ${e.newState}`); if (e.newState === 'closed') b.setAttribute('popover', 'manual'); });
        b.showPopover();
        b.removeAttribute('popover');
        out.push(`${b.matches(':popover-open')} ${b.getAttribute('popover')}`);
        return out;
      })()
    JS
  end

  # HTML "topmost popover ancestor": a popover shown with another showing one as its source is that one's child, which
  # stays open (WPT imperative-invokers); a modal dialog in a hint popover hides the autos but the hint's parent — none
  # here (HTML "hide popovers until", the hint stack parent); and a dialog shown that is a showing popover itself hides
  # it, both its toggles fired. Chrome and Firefox: ["true true", "false true"]; Chrome: "open=true popover=false |
  # closed->open,closed->closed".
  it 'relates popovers by their source and hides them as a dialog shows' do
    s = session_with(<<~HTML)
      <div popover=auto id=a>a</div><div popover=auto id=b>b</div>
      <div popover=auto id=c>c</div><div popover=hint id=h>h<dialog id=d>d</dialog></div>
      <dialog id=dp popover>dp</dialog>
    HTML
    expect(s.evaluate_script(<<~'JS')).to eq(['true true', 'false true'])
      (() => {
        a.showPopover(); b.showPopover({ source: a });
        const related = `${a.matches(':popover-open')} ${b.matches(':popover-open')}`;
        b.hidePopover(); a.hidePopover();
        c.showPopover(); h.showPopover(); d.showModal();
        return [related, `${c.matches(':popover-open')} ${h.matches(':popover-open')}`];
      })()
    JS
    s.execute_script(<<~'JS')
      window.toggles = [];
      dp.addEventListener('beforetoggle', () => dp.showPopover(), { once: true });
      dp.addEventListener('toggle', (e) => toggles.push(`${e.oldState}->${e.newState}`));
      dp.show();
      window.shown = `open=${dp.open} popover=${dp.matches(':popover-open')}`;
    JS
    expect(s.evaluate_script('[shown, toggles.join(",")]')).to eq(['open=true popover=false', 'closed->open,closed->closed'])
  end

  # The close watcher manager (HTML §6.10): close watchers made with no user activation between them share a group,
  # which one close request (the Escape key) closes together — the last first, its `cancel` not cancelable — and a
  # CloseWatcher's requestClose() fires a cancelable `cancel` its listener may prevent (WPT close-watcher/
  # user-activation/nn-CloseWatcher, basic).
  it 'closes the close watchers of one group with one close request' do
    s = session_with('<input id=i><dialog id=d>d</dialog>')
    s.execute_script(<<~'JS')
      window.log = [];
      const w1 = new CloseWatcher();
      w1.oncancel = (e) => log.push(`w1 cancel ${e.cancelable}`);
      w1.onclose = () => log.push('w1 close');
      d.addEventListener('cancel', (e) => log.push(`d cancel ${e.cancelable}`));
      d.addEventListener('close', () => log.push('d close'));
      d.showModal();
      window.w2 = new CloseWatcher();
      w2.oncancel = (e) => { log.push(`w2 cancel ${e.cancelable}`); e.preventDefault(); };
      w2.onclose = () => log.push('w2 close');
      w2.requestClose();
    JS
    s.find(:css, '#d').send_keys(:escape)
    expect(s.evaluate_script('log')).to eq(['w2 cancel true', 'w2 cancel false', 'w2 close', 'd cancel false', 'w1 cancel false', 'w1 close', 'd close'])
  end
end
