# frozen_string_literal: true

require_relative '../script/gen_css_properties'

# The properties the CSSOM is built from are the style engine's, as data (css-properties.js): a property the engine
# gains, loses or renames turns this red until the file is written again.
RSpec.describe 'CSS property table' do
  it "is the style engine's" do
    expect(File.read(CssProperties::FILE)).to eq(CssProperties.source(CssProperties.engine_rows))
  end
end
