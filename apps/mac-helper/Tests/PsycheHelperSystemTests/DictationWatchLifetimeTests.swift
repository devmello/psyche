import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import Testing

@Suite("dictation watch lifetime (review 1402 #4)")
struct DictationWatchLifetimeTests {
    @Test func aWatchDeallocatesOnceNothingHoldsIt() {
        weak var weakWatch: DictationKeyWatcher.Watch?
        do {
            let (_, continuation) = AsyncStream<DictationKeyChange>.makeStream()
            let watch = DictationKeyWatcher.Watch(keys: [DictationWatchedKey(key: .fn)], continuation: continuation)
            weakWatch = watch
            watch.finish()
        }
        #expect(weakWatch == nil)  // no Watch <-> engine cycle: a re-armed dictation.watch leaks nothing
    }
}
