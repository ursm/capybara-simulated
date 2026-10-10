require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML autofocus (§6.6.7): the first element carrying `autofocus` inserted into a document takes focus at the rendering
# update — before its animation frame callbacks — and none after it does, nor one once anything has taken focus; one
# inserted by a script later still does where none was before. Every figure Chrome's (chromedriver, 2026-10-10).
RSpec.describe 'Autofocus' do
  let(:pages) {
    {
      '/' => <<~'HTML',
        <!doctype html><meta charset=utf-8><body><input id=a><input id=b autofocus><input id=c autofocus><pre id=out></pre><script>
        const r=[];const a=()=>document.activeElement.id||document.activeElement.tagName;
        r.push('sync '+a());
        requestAnimationFrame(()=>{r.push('raf '+a()); setTimeout(()=>{r.push('later '+a());
         const d=document.createElement('input'); d.id='d'; d.autofocus=true; document.body.append(d);
         requestAnimationFrame(()=>requestAnimationFrame(()=>{r.push('dyn '+a()); out.textContent=r.join('\n');}));},50);});
        </script>
      HTML
      '/late' => <<~'HTML'
        <!doctype html><meta charset=utf-8><body><input id=a><pre id=out></pre><script>
        const r=[];const a=()=>document.activeElement.id||document.activeElement.tagName;
        setTimeout(()=>{const d=document.createElement('input'); d.id='d'; d.autofocus=true; document.body.append(d);
         requestAnimationFrame(()=>requestAnimationFrame(()=>{r.push('dyn '+a());
         const e=document.createElement('input'); e.id='e'; e.autofocus=true; document.body.append(e);
         requestAnimationFrame(()=>requestAnimationFrame(()=>{r.push('dyn2 '+a()); out.textContent=r.join('\n');}));}));},50);
        </script>
      HTML
    }
  }
  let(:session) { simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] }) }

  it 'focuses the first candidate at the rendering update, and none after' do
    session.visit '/'
    expect(session).to have_css('#out', text: 'dyn')
    expect(session.evaluate_script('out.textContent')).to eq("sync BODY\nraf b\nlater b\ndyn b")
  end

  it "focuses one a script inserts where none was, and not the next" do
    session.visit '/late'
    expect(session).to have_css('#out', text: 'dyn2')
    expect(session.evaluate_script('out.textContent')).to eq("dyn d\ndyn2 d")
  end

  it "finds a candidate in a shadow tree — a declarative one, one set by innerHTML, one inside a host appended" do
    pages['/shadow'] = <<~'HTML'
      <!doctype html><meta charset=utf-8><body><x-h id=dsd><template shadowrootmode=open><input autofocus></template></x-h>
    HTML
    pages['/inner'] = <<~'HTML'
      <!doctype html><meta charset=utf-8><body><div id=h></div><script>h.attachShadow({mode: 'open'}).innerHTML = '<input autofocus>'</script>
    HTML
    pages['/appended'] = <<~'HTML'
      <!doctype html><meta charset=utf-8><body><script>
        const h = document.createElement('div'); h.id = 'h'; h.attachShadow({mode: 'open'}).innerHTML = '<input autofocus>';
        document.body.append(h);
      </script>
    HTML
    {'/shadow' => 'dsd', '/inner' => 'h', '/appended' => 'h'}.each do |path, host|
      session.visit path
      expect(session.evaluate_script('[document.activeElement.id, document.activeElement.shadowRoot?.activeElement.localName]')).to eq([host, 'input']), path
    end
  end
end
