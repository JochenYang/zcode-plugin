import Foundation

typealias Handler = (Int, String) -> Void

protocol Priced: AnyObject {
    var price: Double { get }
    func total(count: Int) -> Double
    associatedtype Currency
}

extension Int: Priced {
    var price: Double { Double(self) }
    func total(count: Int) -> Double { Double(self * count) }
    typealias Currency = USD
    enum USD { case usd }
}

actor Worker {
    private var jobs: [String] = []
    static let shared = Worker()
    lazy var label: String = { "worker" }()

    subscript(index: Int) -> String {
        get { jobs[index] }
        set { jobs[index] = newValue }
    }

    init() {}
    deinit { print("bye") }

    func run(_ job: @escaping () async throws -> Void) async throws {
        guard !jobs.isEmpty else { return }
        do {
            try await job()
        } catch let err as CancellationError {
            print("\(err)")
        } catch {
            return
        }
        for i in jobs.indices where i > 0 {
            print(i, terminator: "")
        }
        switch jobs.first {
        case .some(let name)?:
            print(name)
        default:
            break
        }
        if let first = jobs.first, first.count > 0, let n = Int(first) {
            print(n)
        }
        let fn: Handler = { number, text in print(number, text) }
        fn(1, "x")
        let chained = jobs.first?.uppercased() ?? ""
        let anyP: any Priced = 1
        _ = anyP.total(count: 2)
        _ = try? JSONEncoder().encode(["a"])
        let cls = Worker.self
        _ = cls.shared
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in c.resume() }
    }

    class func helper<T: Equatable>(_ value: T) -> T { value }
}

struct Outer {
    struct Inner {
        static let nested = 1
    }
}

@objc public class Legacy: NSObject {
    @objc dynamic var title: String = ""
    private(set) var readonly = 0
    var computed: Int {
        readonly * 2
    }
}

infix operator <+>: AdditionPrecedence

func <+> (lhs: Int, rhs: Int) -> Int { lhs + rhs }
