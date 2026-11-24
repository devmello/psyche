#if os(iOS)
import CoreLocation
import Foundation

/// The real CoreLocation behind `LocationProviding`. Tests never build this: they use a fake provider.
///
/// Only `requestWhenInUseAuthorization()` is ever called (never "Always"), only `requestLocation()` takes a
/// fix (one shot, no updates), `allowsBackgroundLocationUpdates` stays false and no monitoring of any kind is
/// started, so iOS shows no background-location indicator for this app.
@MainActor
public final class CoreLocationProvider: NSObject, LocationProviding, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var authWaiters: [UUID: CheckedContinuation<LocationAuthorization, Never>] = [:]
    private var fixWaiters: [UUID: CheckedContinuation<LocationFix, any Error>] = [:]

    public override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.allowsBackgroundLocationUpdates = false
        manager.pausesLocationUpdatesAutomatically = true
    }

    nonisolated private static func map(_ status: CLAuthorizationStatus) -> LocationAuthorization {
        switch status {
        case .notDetermined: .notDetermined
        case .authorizedWhenInUse, .authorizedAlways: .authorized
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    public func authorization() async -> LocationAuthorization {
        Self.map(manager.authorizationStatus)
    }

    public func requestWhenInUseAuthorization() async -> LocationAuthorization {
        let current = Self.map(manager.authorizationStatus)
        guard current == .notDetermined else { return current }
        let id = UUID()
        return await withCheckedContinuation { continuation in
            authWaiters[id] = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    public func currentFix() async throws -> LocationFix {
        guard Self.map(manager.authorizationStatus) == .authorized else { throw LocationFailure.unavailable }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                fixWaiters[id] = continuation
                // One waiter asks the system; later waiters share its answer.
                if fixWaiters.count == 1 { manager.requestLocation() }
            }
        } onCancel: {
            Task { @MainActor in self.cancelFix(id) }
        }
    }

    private func cancelFix(_ id: UUID) {
        fixWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    nonisolated public func placeName(for fix: LocationFix) async -> String? {
        await PlaceNamer.name(latitude: fix.latitude, longitude: fix.longitude)
    }

    // MARK: CLLocationManagerDelegate

    nonisolated public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = Self.map(manager.authorizationStatus)
        guard status != .notDetermined else { return }
        Task { @MainActor in
            let waiters = self.authWaiters
            self.authWaiters = [:]
            for (_, waiter) in waiters { waiter.resume(returning: status) }
        }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        let fix = LocationFix(
            latitude: last.coordinate.latitude, longitude: last.coordinate.longitude,
            accuracyMeters: last.horizontalAccuracy, timestamp: last.timestamp)
        Task { @MainActor in
            let waiters = self.fixWaiters
            self.fixWaiters = [:]
            for (_, waiter) in waiters { waiter.resume(returning: fix) }
        }
    }

    nonisolated public func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        Task { @MainActor in
            let waiters = self.fixWaiters
            self.fixWaiters = [:]
            for (_, waiter) in waiters { waiter.resume(throwing: LocationFailure.unavailable) }
        }
    }
}

/// Apple's reverse geocoder on this phone, bounded to a few seconds. The coordinate goes to Apple's location
/// service like any maps lookup on iOS, and to nobody else.
private final class PlaceNamer: @unchecked Sendable {
    private let geocoder = CLGeocoder()

    static func name(latitude: Double, longitude: Double) async -> String? {
        let namer = PlaceNamer()
        return await withTaskCancellationHandler {
            await withTaskGroup(of: String?.self) { group in
                group.addTask { await namer.lookup(latitude: latitude, longitude: longitude) }
                group.addTask {
                    try? await Task.sleep(for: .seconds(4))
                    namer.geocoder.cancelGeocode()
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
        } onCancel: {
            namer.geocoder.cancelGeocode()
        }
    }

    private func lookup(latitude: Double, longitude: Double) async -> String? {
        let marks = try? await geocoder.reverseGeocodeLocation(CLLocation(latitude: latitude, longitude: longitude))
        return marks?.first.flatMap(Self.describe)
    }

    /// "Alexanderplatz, Berlin": the place's own name, then its town, without repeating one in the other.
    static func describe(_ mark: CLPlacemark) -> String? {
        var parts: [String] = []
        for part in [mark.name, mark.locality] {
            guard let part, !part.isEmpty, !parts.contains(part) else { continue }
            parts.append(part)
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}
#endif
