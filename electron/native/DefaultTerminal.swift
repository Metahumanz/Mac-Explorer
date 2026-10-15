import AppKit
import UniformTypeIdentifiers

// macOS has no default-terminal setting. Terminal apps that offer "make default
// terminal" (iTerm2, Ghostty, …) claim public.unix-executable, which Terminal
// also handles out of the box.
guard let application = NSWorkspace.shared.urlForApplication(toOpen: .unixExecutable) else {
    FileHandle.standardError.write(Data("没有可用的终端应用。".utf8))
    exit(1)
}
FileHandle.standardOutput.write(Data(application.path.utf8))
