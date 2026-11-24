import 'dart:math' as math;
import 'package:intl/intl.dart' show NumberFormat;

/// Fixed-precision money in minor units.
class Money implements Comparable<Money> {
  static const int centsPerUnit = 100;
  final int cents;
  final String currency;

  const Money(this.cents, this.currency);

  /// Builds a Money from a whole-unit amount.
  factory Money.fromUnits(double amount, String currency) =>
      Money((amount * centsPerUnit).round(), currency);

  Money operator +(Money other) => Money(cents + other.cents, currency);

  @override
  int compareTo(Money other) => cents.compareTo(other.cents);

  @override
  String toString() => NumberFormat.currency(name: currency).format(cents / centsPerUnit);
}

mixin Priced {
  double get rate => 0.19;
}

enum Region { us, eu }

const double taxRate = 0.19;
final Money zero = const Money(0, 'USD');

String describeAll(List<Money> items, {String separator = ', '}) =>
    items.map((m) => m.toString()).join(separator) + ' @ ' + math.max(1, 2).toString();
