import Foundation

/// Fixed-precision money in minor units.
public struct Money: Equatable, Comparable {
    public static let centsPerUnit = 100
    public let cents: Int
    public private(set) var currency: String
    public static var count = 0

    public init(cents: Int, currency: String) {
        self.cents = cents
        self.currency = currency
    }

    /// Builds a Money from a whole-unit amount.
    public static func fromUnits(_ amount: Double, currency: String) -> Money {
        Money(cents: Int((amount * Double(centsPerUnit)).rounded()), currency: currency)
    }

    public func describe(locale: Locale = Locale.current) -> String {
        let parts = [locale.identifier, currency]
        return parts.joined(separator: " ") + " \(cents / Self.centsPerUnit)"
    }

    public static func < (lhs: Money, rhs: Money) -> Bool {
        lhs.cents < rhs.cents
    }
}

enum Region: String {
    case us, eu
}

let taxRate = 0.19

func formatAll(_ items: [Money], separator: String = ", ") -> String {
    items.map { $0.describe() }.joined(separator: separator)
}
