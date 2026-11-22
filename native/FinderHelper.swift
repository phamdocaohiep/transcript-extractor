import Foundation
import AppKit

let hostVersion = 1
let markerName = ".transcript-extractor-finder.json"
let manager = FileManager.default
enum Failure: Error { case message(String) }

func validId(_ text: String) -> Bool { UUID(uuidString: text) != nil }
func validName(_ text: String) -> Bool {
    !text.isEmpty && text != "." && text != ".." && !text.contains("/") && !text.contains("\\") && !text.contains("\0")
}
func readExact(_ count: Int) throws -> Data {
    var result = Data()
    while result.count < count {
        guard let part = try FileHandle.standardInput.read(upToCount: count - result.count), !part.isEmpty else {
            throw Failure.message("Incomplete message.")
        }
        result.append(part)
    }
    return result
}
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    var size = UInt32(data.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes: &size, count: 4))
    FileHandle.standardOutput.write(data)
}
func markerId(_ directory: URL) throws -> String {
    let marker = directory.appendingPathComponent(markerName)
    let attributes = try manager.attributesOfItem(atPath: marker.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue <= 1024 else { throw Failure.message("Invalid folder connection.") }
    let input = try FileHandle(forReadingFrom: marker)
    defer { try? input.close() }
    guard let bytes = try input.read(upToCount: 1025), bytes.count <= 1024 else { throw Failure.message("Invalid folder connection.") }
    let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    guard value?["version"] as? Int == 1, let id = value?["id"] as? String, validId(id) else {
        throw Failure.message("Invalid folder connection.")
    }
    return id
}
func registryURL(_ origin: String) -> URL {
    let id = String(origin.dropFirst("chrome-extension://".count).dropLast())
    return manager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Transcript Extractor/Finder/\(id).json")
}
func loadRegistry(_ origin: String) throws -> [String: String] {
    let url = registryURL(origin)
    if !manager.fileExists(atPath: url.path) { return [:] }
    return (try JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: String] ?? [:]
}
func saveRegistry(_ value: [String: String], _ origin: String) throws {
    let url = registryURL(origin)
    try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func handle(_ request: [String: Any], _ origin: String) throws -> [String: Any] {
    let action = request["action"] as? String ?? ""
    if action == "ping" { return ["ok": true, "version": hostVersion] }
    guard let id = request["id"] as? String, validId(id) else { throw Failure.message("Invalid folder identifier.") }
    if action == "register" {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "Connect saved folder to Finder"
        panel.message = "Select the same download folder configured in Transcript Extractor. This setup is needed once per folder."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let selected = panel.url else { throw Failure.message("Folder connection cancelled.") }
        let directory = selected.resolvingSymlinksInPath().standardizedFileURL
        guard try markerId(directory) == id else { throw Failure.message("This is not the configured download folder. Select the folder containing the connection marker.") }
        var registry = try loadRegistry(origin)
        registry[id] = directory.path
        try saveRegistry(registry, origin)
        return ["ok": true]
    }
    if action == "reveal" {
        guard let path = try loadRegistry(origin)[id] else { throw Failure.message("Connect this folder to Finder in Settings first.") }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        guard try markerId(directory) == id else { throw Failure.message("The saved folder moved or its connection changed. Reconnect it in Settings.") }
        if let name = request["filename"] as? String {
            guard validName(name) else { throw Failure.message("Invalid saved filename.") }
            let file = directory.appendingPathComponent(name)
            guard manager.fileExists(atPath: file.path) else { throw Failure.message("The saved file no longer exists.") }
            NSWorkspace.shared.activateFileViewerSelecting([file])
        } else {
            guard NSWorkspace.shared.open(directory) else { throw Failure.message("Finder could not open this folder.") }
        }
        return ["ok": true]
    }
    throw Failure.message("Unsupported action.")
}

if CommandLine.arguments.contains("--self-test") {
    guard validName("Vietnamese video.mp4"), !validName("../other"), !validName(".."), !validName("a\\b"), validId(UUID().uuidString) else { exit(1) }
    do {
        let fixture = manager.temporaryDirectory.appendingPathComponent("finder-test-\(UUID().uuidString)")
        try manager.createDirectory(at: fixture, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: fixture) }
        let id = UUID().uuidString
        let marker = fixture.appendingPathComponent(markerName)
        try JSONSerialization.data(withJSONObject: ["version": 1, "id": id]).write(to: marker)
        guard try markerId(fixture) == id else { throw Failure.message("Marker verification failed.") }
        try Data(repeating: 65, count: 1025).write(to: marker)
        var rejected = false
        do { _ = try markerId(fixture) } catch { rejected = true }
        guard rejected else { throw Failure.message("Oversized marker accepted.") }
    } catch { exit(1) }
    print("Finder helper validation passed.")
    exit(0)
}
let origin = CommandLine.arguments.dropFirst().first ?? ""
guard origin.range(of: #"^chrome-extension://[a-p]{32}/$"#, options: .regularExpression) != nil else { exit(1) }
do {
    let header = try readExact(4)
    let size = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * $1.offset) }
    guard size > 0 && size <= 65536 else { throw Failure.message("Invalid message length.") }
    let value = try JSONSerialization.jsonObject(with: readExact(Int(size)))
    guard let request = value as? [String: Any] else { throw Failure.message("Invalid message.") }
    emit(try handle(request, origin))
} catch Failure.message(let message) { emit(["ok": false, "error": message]) }
catch { emit(["ok": false, "error": "Could not access the connected folder. Reconnect it in Settings."]) }
