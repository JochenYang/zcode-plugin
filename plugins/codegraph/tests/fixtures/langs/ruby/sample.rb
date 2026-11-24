# frozen_string_literal: true

require 'json'
require_relative '../support/reader'

DEFAULT_CURRENCY = 'EUR'

module Cart
  MAX_ITEMS = 10

  # An item in the shopping cart.
  class Item
    attr_accessor :code, :price

    def initialize(code, price)
      @code = code
      @price = price
    end

    def discounted(rate)
      @price * (1 - rate)
    end
  end

  # Loads items from a JSON file.
  def self.load(path)
    data = JSON.parse(File.read(path))
    data.map { |row| Item.new(row['code'], row['price']) }
  end

  def self.total(items)
    items.sum(&:price)
  end
end

puts Cart.load('cart.json').length
