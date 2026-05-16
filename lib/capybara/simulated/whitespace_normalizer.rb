# frozen_string_literal: true

module Capybara
  module Simulated
    # `Capybara::Node::WhitespaceNormalizer` was extracted in capybara
    # 3.40 — Forem (and other apps that pin `~> 3.37`) still ship the
    # older release where the module doesn't exist. Inline copies of
    # `normalize_spacing` / `normalize_visible_spacing` keep the gem
    # working against the whole 3.37+ range; they're stable text-
    # processing helpers, no behavioural drift to worry about.
    module WhitespaceNormalizer
      NON_BREAKING_SPACE  = " "
      LINE_SEPERATOR      = " "
      PARAGRAPH_SEPERATOR = " "
      BREAKING_SPACES     = "[[:space:]&&[^#{NON_BREAKING_SPACE}]]".freeze
      SQUEEZED_SPACES     = " \n\f\t\v#{LINE_SEPERATOR}#{PARAGRAPH_SEPERATOR}".freeze
      LEADING_SPACES      = /\A#{BREAKING_SPACES}+/
      TRAILING_SPACES     = /#{BREAKING_SPACES}+\z/
      ZERO_WIDTH_SPACE    = "​"
      LEFT_TO_RIGHT_MARK  = "‎"
      RIGHT_TO_LEFT_MARK  = "‏"
      REMOVED_CHARACTERS  = [ZERO_WIDTH_SPACE, LEFT_TO_RIGHT_MARK, RIGHT_TO_LEFT_MARK].join
      EMPTY_LINES         = /[\ \n]*\n[\ \n]*/

      def normalize_spacing(text)
        text
          .delete(REMOVED_CHARACTERS)
          .tr(SQUEEZED_SPACES, ' ')
          .squeeze(' ')
          .sub(LEADING_SPACES, '')
          .sub(TRAILING_SPACES, '')
          .tr(NON_BREAKING_SPACE, ' ')
      end

      def normalize_visible_spacing(text)
        text
          .squeeze(' ')
          .gsub(EMPTY_LINES, "\n")
          .sub(LEADING_SPACES, '')
          .sub(TRAILING_SPACES, '')
          .tr(NON_BREAKING_SPACE, ' ')
      end
    end
  end
end
