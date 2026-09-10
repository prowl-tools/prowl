import ApplicationServices
@testable import ProwlMacDriverCore
import XCTest

/// Deterministic coverage of the pure wait loop (ARCH-008). A manual clock is
/// advanced by the injected `pumpEvents` / `fallbackSleep` seams so the timeout
/// and event/poll branches are exercised without a live app or CFRunLoop.
final class AXEventWaiterTests: XCTestCase {
    private final class Harness {
        private(set) var current = Date(timeIntervalSince1970: 0)
        let deadline: Date
        private(set) var registerCount = 0
        private(set) var teardownCount = 0
        private(set) var pumpCount = 0
        private(set) var sleepCount = 0
        var registeredNotifications = 0

        init(timeout: TimeInterval) {
            deadline = current.addingTimeInterval(timeout)
        }

        func now() -> Date { current }

        func register() -> Int {
            registerCount += 1
            return registeredNotifications
        }

        func teardown() { teardownCount += 1 }

        func pump(_ interval: TimeInterval) {
            pumpCount += 1
            current = current.addingTimeInterval(interval)
        }

        func sleep(_ micros: useconds_t) {
            sleepCount += 1
            current = current.addingTimeInterval(Double(micros) / 1_000_000)
        }
    }

    func testImmediatePredicateResolvesWithoutSubscribing() {
        let h = Harness(timeout: 5)
        let outcome = AXEventWaiter.drive(
            deadline: h.deadline,
            predicate: { true },
            now: h.now,
            registerObserver: h.register,
            teardown: h.teardown,
            pumpEvents: h.pump,
            fallbackSleep: h.sleep
        )
        XCTAssertTrue(outcome.resolved)
        XCTAssertFalse(outcome.degradedToPolling)
        XCTAssertEqual(h.registerCount, 0)
        XCTAssertEqual(h.teardownCount, 0)
        XCTAssertEqual(h.pumpCount, 0)
        XCTAssertEqual(h.sleepCount, 0)
    }

    func testEventDrivenResolutionUsesPumpNotFallbackSleep() {
        let h = Harness(timeout: 10)
        h.registeredNotifications = 3
        var checks = 0
        let outcome = AXEventWaiter.drive(
            deadline: h.deadline,
            predicate: {
                checks += 1
                return checks > 3 // false on the immediate check + first two loop checks
            },
            now: h.now,
            registerObserver: h.register,
            teardown: h.teardown,
            pumpEvents: h.pump,
            fallbackSleep: h.sleep
        )
        XCTAssertTrue(outcome.resolved)
        XCTAssertFalse(outcome.degradedToPolling)
        XCTAssertEqual(h.registerCount, 1)
        XCTAssertEqual(h.teardownCount, 1)
        XCTAssertEqual(h.pumpCount, 2)
        XCTAssertEqual(h.sleepCount, 0)
    }

    func testDegradesToPollingWhenNoNotificationRegistered() {
        let h = Harness(timeout: 10)
        h.registeredNotifications = 0
        var checks = 0
        let outcome = AXEventWaiter.drive(
            deadline: h.deadline,
            predicate: {
                checks += 1
                return checks > 2
            },
            now: h.now,
            registerObserver: h.register,
            teardown: h.teardown,
            pumpEvents: h.pump,
            fallbackSleep: h.sleep
        )
        XCTAssertTrue(outcome.resolved)
        XCTAssertTrue(outcome.degradedToPolling)
        XCTAssertEqual(h.pumpCount, 0)
        XCTAssertEqual(h.sleepCount, 1)
        XCTAssertEqual(h.teardownCount, 1)
    }

    func testTimesOutInEventModeWhenPredicateNeverResolves() {
        let h = Harness(timeout: 3)
        h.registeredNotifications = 2
        let outcome = AXEventWaiter.drive(
            deadline: h.deadline,
            predicate: { false },
            now: h.now,
            registerObserver: h.register,
            teardown: h.teardown,
            pumpEvents: h.pump,
            fallbackSleep: h.sleep
        )
        XCTAssertFalse(outcome.resolved)
        XCTAssertFalse(outcome.degradedToPolling)
        XCTAssertEqual(h.teardownCount, 1)
        // Safety re-poll runs at 1s; a 3s deadline pumps three times then errors.
        XCTAssertEqual(h.pumpCount, 3)
        XCTAssertGreaterThanOrEqual(h.current, h.deadline)
    }

    func testTimesOutInPollingModeWhenPredicateNeverResolves() {
        let h = Harness(timeout: 0.3)
        h.registeredNotifications = 0
        let outcome = AXEventWaiter.drive(
            deadline: h.deadline,
            predicate: { false },
            now: h.now,
            registerObserver: h.register,
            teardown: h.teardown,
            pumpEvents: h.pump,
            fallbackSleep: h.sleep
        )
        XCTAssertFalse(outcome.resolved)
        XCTAssertTrue(outcome.degradedToPolling)
        XCTAssertEqual(h.pumpCount, 0)
        // 100ms poll cadence across a 300ms deadline: ~3 sleeps (a sub-cadence
        // tail sleep can round the count up, but the deadline is always honored).
        XCTAssertGreaterThanOrEqual(h.sleepCount, 3)
        XCTAssertGreaterThanOrEqual(h.current, h.deadline)
    }
}
