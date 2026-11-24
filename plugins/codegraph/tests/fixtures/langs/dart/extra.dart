library extra;

import 'dart:async' hide Timer;
import 'dart:convert' as convert show jsonEncode;
export 'src/extra.dart' show helper;
part 'extra_part.dart';

typedef Handler = void Function(int value, {String? tag});

abstract class Base<T extends Comparable<T>> implements Comparable<Base<T>> {
  Base();
  const Base.constant();
  factory Base.create() = _Impl;
  Base.redirect() : this.constant();

  int get count;
  set count(int value);
  Future<void> load() async {
    var x = 1;
    late final String y;
    int helper(int a, [int b = 2]) => a + b;
    try {
      throw StateError('x');
    } on StateError catch (err, stack) {
      print('$err $stack');
    } catch (other) {
      rethrow;
    }
    for (final MapEntry(:key, :value) in {1: 'a'}.entries) {
      print('$key=$value');
    }
    await Future.value(1);
    final list = <int>[1, 2, ...?null];
    final (a, b) = (1, 2);
    switch (x) {
      case int n when n > 0:
        print(n);
      case _:
        break;
    }
    final obj = new Base.create();
    final encoded = convert.jsonEncode(list);
    for (var i in list) {
      if (i == 2) continue;
    }
    return;
  }

  @override
  int compareTo(Base<T>? other) => 0;
}

class _Impl extends Base<int> {
  @override
  int count = 0;
}

extension StringExt on String {
  String get reversed => split('').reversed.join();
}

mixin Loggable on Object {
  void log() => print(this);
}

mixin class Both {}

final class Sealed {}
