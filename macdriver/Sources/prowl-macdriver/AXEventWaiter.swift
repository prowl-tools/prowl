// AXEventWaiter.swift — event-driven waiting for the macOS helper (ARCH-008).
//
// The pre-ARCH-008 helper waited by polling on a 100ms sleep. macOS exposes an
// `AXObserver` API that *pushes* accessibility notifications (a window created,
// an element destroyed, focus/value changed, a menu opened/closed…), so a wait
// can resolve the instant the state actually changes instead of on the next
// poll tick. This is a hybrid design, not pure-event, because AX apps routinely
// fail to announce a change:
//
//   1. one immediate predicate check (the element may already be there);
//   2. subscribe to the relevant notifications and re-run the predicate whenever
//      one fires;
//   3. a SLOW safety re-poll underneath (every `safetyPollInterval`), because a
//      change AX never announced must still be caught before the deadline;
//   4. if *no* notification could be registered, degrade to the classic 100ms
//      polling loop and report it.
//
// The helper is a synchronous JSON-over-stdio command loop, so the wait runs on
// the command thread and pumps that thread's own CFRunLoop for the duration —
// the observer's run-loop source is added to `CFRunLoopGetCurrent()` and driven
// with `CFRunLoopRunInMode`. The observer is torn down when the wait completes
// so nothing leaks across commands. The deadline is honored exactly: a wait that
// never resolves returns `resolved == false` at its deadline, and the caller
// turns that into the same timeout error as before.

import ApplicationServices
import Foundation

/// The accessibility notifications a wait subscribes to on the attached app.
/// Registration is best-effort *per notification* — apps decline to announce
/// some (`kAXErrorNotificationUnsupported`), which is expected, never fatal.
let axWaitNotifications: [String] = [
    kAXWindowCreatedNotification as String,
    kAXUIElementDestroyedNotification as String,
    kAXFocusedUIElementChangedNotification as String,
    kAXValueChangedNotification as String,
    kAXMenuOpenedNotification as String,
    kAXMenuClosedNotification as String,
    kAXCreatedNotification as String,
    kAXLayoutChangedNotification as String,
    kAXRowCountChangedNotification as String,
    kAXSelectedChildrenChangedNotification as String
]

/// What a single wait is asking for. `emit` is invoked with the notification
/// name each time a subscribed AX notification fires during the wait, so the
/// helper can surface a server-initiated event line to the TypeScript client.
struct WaitRequest {
    let app: AXUIElement
    let pid: pid_t
    let deadline: Date
    let cmd: String
    let predicate: () -> Bool
    let emit: (String) -> Void
}

/// The result of a wait. `degradedToPolling` is true when *no* AX notification
/// could be registered and the wait fell back to the classic 100ms poll loop.
struct WaitOutcome {
    let resolved: Bool
    let degradedToPolling: Bool
}

enum AXEventWaiter {
    /// Slow safety re-poll interval while event-driven — a change AX failed to
    /// announce is still caught within this bound, well under any real deadline.
    static let safetyPollInterval: TimeInterval = 1.0
    /// Classic poll cadence used only when no notification could be registered.
    static let fallbackPollMicros: useconds_t = 100_000

    /// Resolve a wait against the live AX/CFRunLoop APIs. Wires the real observer
    /// setup, run-loop pump, and teardown into the pure {@link drive} loop below.
    static func run(_ request: WaitRequest) -> WaitOutcome {
        let box = ObserverBox(request: request)
        return drive(
            deadline: request.deadline,
            predicate: request.predicate,
            now: Date.init,
            registerObserver: box.register,
            teardown: box.teardown,
            pumpEvents: { interval in CFRunLoopRunInMode(.defaultMode, interval, true) },
            fallbackSleep: { usleep($0) }
        )
    }

    /// Pure wait loop, isolated from the AX/CFRunLoop specifics so it is unit
    /// testable with a manual clock and fake seams:
    ///   - `registerObserver` sets up the observer and returns how many
    ///     notifications registered (0 ⇒ degrade to polling);
    ///   - `pumpEvents` blocks up to `interval` for a notification (event mode);
    ///   - `fallbackSleep` is the classic poll sleep (degraded mode);
    ///   - `teardown` always runs once the wait completes.
    ///
    /// Order matches the ARCH-008 design: immediate check, subscribe, then loop
    /// re-checking on each wake. The deadline is honored exactly.
    static func drive(
        deadline: Date,
        predicate: () -> Bool,
        now: () -> Date,
        registerObserver: () -> Int,
        teardown: () -> Void,
        pumpEvents: (TimeInterval) -> Void,
        fallbackSleep: (useconds_t) -> Void
    ) -> WaitOutcome {
        // 1. Immediate check — the state may already satisfy the predicate.
        if predicate() { return WaitOutcome(resolved: true, degradedToPolling: false) }

        // 2. Subscribe (best-effort). Zero registrations ⇒ degrade to polling.
        let registered = registerObserver()
        defer { teardown() }
        let degraded = registered == 0

        // 3. Loop, re-checking the predicate on every wake until the deadline.
        while now() < deadline {
            if predicate() {
                return WaitOutcome(resolved: true, degradedToPolling: degraded)
            }
            let remaining = deadline.timeIntervalSince(now())
            if remaining <= 0 { break }
            if degraded {
                let cappedMicros = min(fallbackPollMicros, useconds_t(remaining * 1_000_000))
                fallbackSleep(max(cappedMicros, 1))
            } else {
                pumpEvents(min(safetyPollInterval, remaining))
            }
        }

        // 4. One last check right at the deadline before declaring a timeout.
        return WaitOutcome(resolved: predicate(), degradedToPolling: degraded)
    }
}

/// Owns the live `AXObserver` for one wait: creates it for the target pid,
/// registers each notification best-effort, adds its run-loop source to the
/// current run loop, and unregisters/removes on teardown so nothing leaks across
/// commands. A reference type so the C observer callback can reach it via a
/// `refcon` pointer without capturing state in the `@convention(c)` closure.
private final class ObserverBox {
    private let request: WaitRequest
    private var observer: AXObserver?
    private var source: CFRunLoopSource?
    private let runLoop = CFRunLoopGetCurrent()

    init(request: WaitRequest) {
        self.request = request
    }

    /// Returns the number of notifications that registered successfully.
    func register() -> Int {
        guard AXObserverCreate(request.pid, axWaitObserverCallback, &observer) == .success,
              let observer else {
            return 0
        }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var count = 0
        for name in axWaitNotifications
        where AXObserverAddNotification(observer, request.app, name as CFString, refcon) == .success {
            count += 1
        }
        if count > 0 {
            let src = AXObserverGetRunLoopSource(observer)
            CFRunLoopAddSource(runLoop, src, .defaultMode)
            source = src
        }
        return count
    }

    func teardown() {
        if let source {
            CFRunLoopRemoveSource(runLoop, source, .defaultMode)
            self.source = nil
        }
        if let observer {
            for name in axWaitNotifications {
                AXObserverRemoveNotification(observer, request.app, name as CFString)
            }
            self.observer = nil
        }
    }

    fileprivate func handleNotification(_ name: String) {
        request.emit(name)
    }
}

/// C observer callback: routes each notification back to its `ObserverBox` via
/// the `refcon`. Waking the run loop (which returns control to the pump) is what
/// actually advances the wait; the emit is for observability.
private let axWaitObserverCallback: AXObserverCallback = { _, _, notification, refcon in
    guard let refcon else { return }
    let box = Unmanaged<ObserverBox>.fromOpaque(refcon).takeUnretainedValue()
    box.handleNotification(notification as String)
}
