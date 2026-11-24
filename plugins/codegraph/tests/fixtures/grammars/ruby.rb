# frozen_string_literal: true

class Greeter
  attr_reader :name

  def initialize(name)
    @name = name
  end

  def greet
    "Hello, #{@name}!"
  end
end

greeter = Greeter.new("world")
puts greeter.greet
