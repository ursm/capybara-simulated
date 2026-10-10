require 'capybara/simulated'
require_relative 'support/session_teardown'

# INERT nodes (HTML §6.6.2) — under an `inert` attribute, or outside the topmost modal dialog — are as if absent to the
# user: the hit test passes through them (a point on a modal's backdrop finds the dialog), they take no focus, and the
# driver refuses to type into one as WebDriver does ("element not interactable"; Chrome's driver, 2026-10-10), a
# refusal Capybara retries until the dialog has gone.
RSpec.describe 'Inert nodes' do
  let(:html) {
    <<~HTML
      <!doctype html><meta charset=utf-8><style>body{margin:0}</style>
      <input id=behind><button id=b onclick="window.clicked = true">b</button>
      <div inert><input id=sub></div>
      <input type=file id=upload><input type=checkbox id=cb>
      <dialog id=d><button id=close onclick="setTimeout(() => d.close(), 200)">close</button></dialog>
    HTML
  }
  let(:session) { simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] }) }

  it 'refuses to type into an inert control' do
    session.visit '/'
    expect { session.find('#sub').set('x') }.to raise_error(Capybara::Simulated::ElementNotInteractable)
    expect(session.evaluate_script('sub.value')).to eq('')
  end

  it 'leaves the rest of the document to a modal dialog until it closes' do
    session.visit '/'
    session.execute_script('d.showModal()')
    expect(session.evaluate_script('[document.elementFromPoint(5, 5).id, (behind.focus(), document.activeElement.id)]')).to eq(%w[d close])
    expect { session.find('#behind').set('x') }.to raise_error(Capybara::Simulated::ElementNotInteractable)
    # (…a checkbox's `set` is a click, intercepted; a file input takes its files inert or not, as chromedriver attaches
    # to an uploader's input left outside the modal)
    expect { session.find('#cb').set(true) }.to raise_error(Capybara::Simulated::ClickIntercepted)
    session.find('#upload').set(__FILE__)
    expect(session.evaluate_script('[upload.files.length, document.elementsFromPoint(5, 5).map((e) => e.localName)]')).to eq([1, %w[dialog html]])
    session.click_button 'close'
    session.fill_in 'behind', with: 'typed'
    expect(session.evaluate_script('[behind.value, document.getElementById("d").open]')).to eq(['typed', false])
  end
end
