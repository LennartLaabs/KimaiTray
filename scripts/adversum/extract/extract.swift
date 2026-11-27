// SHELVED (2026-11-27): not built, not shipped and never run. The local
// language model (src-tauri/llm-helper) took its place. Kept for reference.
//
// ADVERSUM: reads the activities out of a sentence with Apple's on-device
// language model (Foundation Models, macOS 26 or later with Apple
// Intelligence switched on). Nothing leaves the Mac.
//
//   kimaitray-extract --check            prints "available", or why not (exit 1)
//   kimaitray-extract "<instructions>"   reads the sentence from standard
//                                        input, prints the activities as JSON
//
// The app only extracts with it and never lets it calculate; see
// src/adversum/multi/extract.ts for the instructions and for the checks the
// answer goes through. Built by build.sh when the installed SDK has the
// framework.

import Foundation
import FoundationModels

@Generable
struct Activity: Codable {
    @Guide(description: "The words from the sentence that name the customer, the project, the kind of work and what was done")
    var task: String
    @Guide(description: "Duration said for this activity in minutes, of one occurrence if repeated; 0 if none was said")
    var minutes: Int
    @Guide(description: "How often, if a number was said; else 0")
    var count: Int
    @Guide(description: "True if it happened several times")
    var repeated: Bool
    @Guide(description: "True if the duration was only 'kurz' or 'ein paar Minuten'")
    var vague: Bool
    @Guide(description: "True for 'der Rest'")
    var rest: Bool
    @Guide(description: "within, after, before or none")
    var relation: String
    @Guide(description: "Start as HH:MM if a clock time was said, else empty")
    var from: String
    @Guide(description: "End as HH:MM if a clock time was said, else empty")
    var to: String
}

@Generable
struct Extraction: Codable {
    @Guide(description: "Minutes of the time span all activities lie in, if one was said; else 0")
    var window_minutes: Int
    var activities: [Activity]
}

func fail(_ message: String, code: Int32) -> Never {
    print(message)
    exit(code)
}

@main
struct Extract {
    static func main() async {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(let reason):
            fail("unavailable: \(reason)", code: 1)
        }
        let arguments = CommandLine.arguments.dropFirst()
        if arguments.first == "--check" {
            print("available")
            return
        }
        guard let instructions = arguments.first else {
            fail("usage: kimaitray-extract --check | <instructions>", code: 64)
        }
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let sentence = String(decoding: input, as: UTF8.self)
        do {
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: sentence, generating: Extraction.self)
            let json = try JSONEncoder().encode(response.content)
            print(String(decoding: json, as: UTF8.self))
        } catch {
            fail("failed: \(error)", code: 2)
        }
    }
}
