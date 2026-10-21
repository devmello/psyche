import Foundation

/// How each TCC permission is explained, requested and opened in System Settings (feature A9;
/// security §12 table and request order). Preflight APIs only: Psyche never reads `TCC.db`.
public enum PermissionCatalog {
    public enum RequestStyle: String, Sendable {
        /// The system shows a prompt (Accessibility, Microphone, …).
        case prompt
        /// Only the user can grant it in System Settings (Full Disk Access).
        case settingsOnly
        /// Asked per target app on first use (Automation).
        case perTarget
    }

    public struct Entry: Sendable {
        public var permission: TCCPermission
        public var title: String
        public var explanation: String
        public var whenRequested: String
        public var settingsURL: String
        public var style: RequestStyle
    }

    /// Order the onboarding and the agent request them in (security §12): Accessibility first;
    /// Notifications at onboarding (provisional first); the rest on first use.
    public static let order: [TCCPermission] = [
        .accessibility, .notifications, .microphone, .speechRecognition, .automation, .calendars, .reminders,
        .contacts, .screenRecording, .fullDiskAccess, .inputMonitoring,
    ]

    static let privacy = "x-apple.systempreferences:com.apple.preference.security?"

    public static func entry(_ p: TCCPermission) -> Entry {
        switch p {
        case .accessibility:
            Entry(permission: p, title: "Accessibility",
                  explanation: "Lets Psyche read the controls in the apps you allow and click or type in them. Each app also has its own tier (Off, Read only, Read and interact).",
                  whenRequested: "first computer-use tier above Off", settingsURL: privacy + "Privacy_Accessibility", style: .prompt)
        case .screenRecording:
            Entry(permission: p, title: "Screen & System Audio Recording",
                  explanation: "Only needed when an app's controls cannot be read and Psyche must look at the screen. Psyche's windows, terminals and apps set to Off are never captured. macOS asks again monthly.",
                  whenRequested: "first screenshot fallback", settingsURL: privacy + "Privacy_ScreenCapture", style: .prompt)
        case .automation:
            Entry(permission: p, title: "Automation",
                  explanation: "Lets Psyche send Apple Events to one app at a time (Mail, Notes, Messages, Shortcuts). macOS asks the first time for each app.",
                  whenRequested: "first Apple Event to each app", settingsURL: privacy + "Privacy_Automation", style: .perTarget)
        case .fullDiskAccess:
            Entry(permission: p, title: "Full Disk Access",
                  explanation: "Only needed to read your Messages history. macOS does not let apps ask for it: add Psyche (Helper) in System Settings › Privacy & Security › Full Disk Access.",
                  whenRequested: "when iMessage reading is turned on", settingsURL: privacy + "Privacy_AllFiles", style: .settingsOnly)
        case .calendars:
            Entry(permission: p, title: "Calendars",
                  explanation: "Lets Psyche read and add events when you turn on the Calendar connector. macOS has no read-only option.",
                  whenRequested: "when the Calendar connector is enabled", settingsURL: privacy + "Privacy_Calendars", style: .prompt)
        case .reminders:
            Entry(permission: p, title: "Reminders",
                  explanation: "Lets Psyche read and add reminders when you turn on the Reminders connector.",
                  whenRequested: "when the Reminders connector is enabled", settingsURL: privacy + "Privacy_Reminders", style: .prompt)
        case .contacts:
            Entry(permission: p, title: "Contacts",
                  explanation: "Lets Psyche look up the people you mention when you turn on the Contacts connector.",
                  whenRequested: "when the Contacts connector is enabled", settingsURL: privacy + "Privacy_Contacts", style: .prompt)
        case .microphone:
            Entry(permission: p, title: "Microphone",
                  explanation: "Used only while you dictate. Audio is transcribed on this Mac.",
                  whenRequested: "first dictation", settingsURL: privacy + "Privacy_Microphone", style: .prompt)
        case .speechRecognition:
            Entry(permission: p, title: "Speech Recognition",
                  explanation: "Lets macOS transcribe your dictation on this Mac.",
                  whenRequested: "first dictation on older macOS", settingsURL: privacy + "Privacy_SpeechRecognition", style: .prompt)
        case .notifications:
            Entry(permission: p, title: "Notifications",
                  explanation: "Shows approvals, questions and finished tasks with action buttons. Starts quietly in Notification Center until you choose to keep them.",
                  whenRequested: "onboarding (provisional first)",
                  settingsURL: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.psyche.helper", style: .prompt)
        case .inputMonitoring:
            Entry(permission: p, title: "Input Monitoring",
                  explanation: "Covered by Accessibility on current macOS; used for the global Esc key that stops computer use.",
                  whenRequested: "with Accessibility", settingsURL: privacy + "Privacy_ListenEvent", style: .prompt)
        }
    }

    /// The next permission to ask for, given what is granted and which features are wanted.
    /// Screen Recording is only suggested for the vision fallback; Full Disk Access only for Messages.
    public static func next(granted: Set<TCCPermission>, wanted: Set<TCCPermission>) -> TCCPermission? {
        order.first { wanted.contains($0) && !granted.contains($0) }
    }
}
