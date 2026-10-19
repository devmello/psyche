import PsycheHelperSystem
import Testing

@Test func versionIsSemver() {
    #expect(HelperVersion.current.split(separator: ".").count == 3)
}
