//! D9/D12: the tool and the command of a permission request, read from the card text the hook already wrote.
//!
//! The island's card (`apps/desktop-harness/src/hook-common.cjs`, `questionText`) is the only place the desktop holds
//! a permission in words, so the phone's `approval.tool` / `approval.command` are parsed from it instead of invented:
//!
//! * `<Agent> pide permiso para <shown>` / `<Agent> asks permission: <shown>` — the two lossless shapes;
//! * `<Agent> asks permission for <shown>` — the English lossy shape;
//! * `<Agent> pide permiso (recortado; detalles solo en la terminal)` — the whole-text lossy shape, which says nothing
//!   about the request at all.
//!
//! `shown` is `Bash: <redacted command line>` for Bash and a short description for everything else, and the hook
//! appends a closed set of tails to it. Those tails are card chrome, never part of what runs, so the command keeps
//! them out. A text that carries the lossy tail means the island could not show the whole request: D12 then sends the
//! approval with `truncated: true`, and the phone offers only Denegar.
//!
//! Nothing here truncates, escapes or reorders a command: the fingerprint is computed over the WHOLE text (D9), and
//! this module only decides what the sheet shows.

use super::asks::MAX_COMMAND_CHARS;

/// One card, read: the tool as the sheet's eyebrow, the command (or one-line summary) under it, and whether the
/// island could not show the request whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    pub tool: String,
    /// The command line (Bash) or the one-line summary (any other tool). The phone cuts it to 500 characters, and
    /// the cut is flagged on the wire (§8.4).
    pub command: String,
    /// D12: the phone must not offer Allow for this request.
    pub lossy: bool,
}

/// What a text that names no tool at all is filed under (D9: «Permission» + the sentence).
const NO_TOOL: &str = "Permission";

/// The prefix that opens the shown text, in the order they are looked for.
const PREFIXES: [&str; 3] = [" pide permiso para ", " asks permission: ", " asks permission for "];
/// The Bash marker: everything after it is the command line.
const BASH: &str = "Bash: ";

/// The tool names the hook prints before a description (`projection.cjs` FILE_TOOLS and the Claude/Codex tool set).
/// D9's list, verbatim: any other word is not a tool name, so the request is filed under [`NO_TOOL`].
const TOOL_NAMES: [&str; 11] =
    ["Edit", "Write", "MultiEdit", "Read", "WebFetch", "WebSearch", "Glob", "Grep", "NotebookEdit", "Task", "apply_patch"];

/// The tails `questionText` appends to a card, worth removing from the command because none of them will run.
const SECRET_TAILS: [&str; 2] = [" (secretos ocultos)", " (secrets hidden)"];
/// The lossy tail without a reason (`comando recortado` and the other reasons are printed inside it).
const LOSSY_TAILS: [&str; 2] = [" (detalles solo en la terminal; decidir en la terminal)", " (details only in the terminal)"];
/// The closed reason set, each printed as ` (<reason>; …)` inside the lossy tail above.
const ES_REASONS: [&str; 6] = [
    "comando recortado",
    "caracteres especiales",
    "ruta sensible",
    "indirección de shell",
    "el texto oculto puede contener sintaxis de shell",
    "el texto oculto puede ser una ruta",
];
const EN_REASONS: [&str; 6] = [
    "long command",
    "special characters",
    "touches credential files",
    "shell indirection",
    "hidden text may contain shell syntax",
    "hidden text may be a path",
];

/// The markers that mean «the island could not show this whole request» (D12). Every lossy card carries one: the
/// lossy tail always names the terminal, and the whole-text shape says «recortado; detalles solo en la terminal».
const LOSSY_MARKERS: [&str; 3] = ["decidir en la terminal", "detalles solo en la terminal", "details only in the terminal"];

/// Whether this card is one the phone must not allow (D12).
pub fn is_lossy(text: &str) -> bool {
    LOSSY_MARKERS.iter().any(|marker| text.contains(marker))
}

/// Read one card (D9): after the card's own prefix, `Bash: ` marks a command line and anything else is a tool name
/// followed by a one-line summary when it is one of the known tools, and the whole shown text under [`NO_TOOL`]
/// otherwise. A text in no known shape says nothing about the tool, so the whole sentence is kept.
pub fn shown(text: &str) -> Shown {
    let lossy = is_lossy(text);
    let Some(rest) = text.split_once(PREFIXES[0]).map(|(_, rest)| rest)
        .or_else(|| text.split_once(PREFIXES[1]).map(|(_, rest)| rest))
        .or_else(|| text.split_once(PREFIXES[2]).map(|(_, rest)| rest))
    else {
        return Shown { tool: NO_TOOL.into(), command: clip(text, MAX_COMMAND_CHARS), lossy };
    };
    match rest.strip_prefix(BASH) {
        // The tails are card chrome, never part of the command line: they are removed before the cut.
        Some(command) => Shown { tool: "Bash".into(), command: command_of(command), lossy },
        None => Shown { tool: tool_of(rest), command: clip(rest, MAX_COMMAND_CHARS), lossy },
    }
}

/// The tool a summary opens with, when it opens with one the agent names.
fn tool_of(summary: &str) -> String {
    let word = summary.split_whitespace().next().unwrap_or("");
    let name = word.strip_suffix(':').unwrap_or(word);
    // D9 also lists «mcp…»: the harness prints `mcp tool Server/Tool`, so the word itself is the tool's name.
    let known = TOOL_NAMES.contains(&name) || name.starts_with("mcp");
    if known { name.to_string() } else { NO_TOOL.to_string() }
}

/// The first `max` characters, on a character boundary.
pub fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// The command as the phone is shown it: the tails out, then `MAX_COMMAND_CHARS` at most.
fn command_of(text: &str) -> String {
    clip(strip_tails(text), MAX_COMMAND_CHARS)
}

/// Every known tail removed from the end (the secrets notice comes before the lossy one). The first prefix wins: a
/// command that happens to contain another one is not parsed again.
fn strip_tails(mut s: &str) -> &str {
    loop {
        let before = s;
        for tail in SECRET_TAILS.iter().chain(LOSSY_TAILS.iter()) {
            if let Some(rest) = s.strip_suffix(tail) {
                s = rest;
            }
        }
        for reason in ES_REASONS {
            if let Some(rest) = s.strip_suffix(&format!(" ({reason}; detalles solo en la terminal; decidir en la terminal)")) {
                s = rest;
            }
        }
        for reason in EN_REASONS {
            if let Some(rest) = s.strip_suffix(&format!(" ({reason}; details only in the terminal)")) {
                s = rest;
            }
        }
        if s == before {
            return s;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The card of a lossless Bash request: the command line verbatim, no tail.
    #[test]
    fn a_lossless_bash_card_is_the_command_line() {
        let card = "Claude Code pide permiso para Bash: npm run build";
        let read = shown(card);
        assert_eq!(read.tool, "Bash");
        assert_eq!(read.command, "npm run build");
        assert!(!read.lossy, "nothing hid the request: the phone may allow it");
        // The hook never flags a request it showed whole, and neither do we.
        assert!(!is_lossy(card));
    }

    /// The secrets notice is card chrome: it is not part of the command, and it does not make the request lossy.
    #[test]
    fn the_secrets_notice_is_not_part_of_the_command() {
        for (card, command) in [
            (
                "Claude Code pide permiso para Bash: curl -H 'Authorization: x' https://example.test (secretos ocultos)",
                "curl -H 'Authorization: x' https://example.test",
            ),
            ("Codex asks permission: Bash: git log (secrets hidden)", "git log"),
        ] {
            let read = shown(card);
            assert_eq!(read.tool, "Bash", "{card}");
            assert_eq!(read.command, command, "{card}");
            assert!(!read.lossy, "hiding a secret is not hiding the request: {card}");
        }
    }

    /// Every lossy shape: the tail is out of the command and the request is never allowable from the phone.
    #[test]
    fn every_lossy_shape_is_flagged_and_its_tails_are_not_the_command() {
        let card = "Claude Code pide permiso para Bash: for f in *; do rm $f; done \
                    (indirección de shell; detalles solo en la terminal; decidir en la terminal)";
        let read = shown(card);
        assert_eq!(read.tool, "Bash");
        assert_eq!(read.command, "for f in *; do rm $f; done");
        assert!(read.lossy, "D12: an Allow must never be applied to this");

        let no_reason = "Codex pide permiso para Bash: make (detalles solo en la terminal; decidir en la terminal)";
        assert_eq!(shown(no_reason).command, "make");
        assert!(shown(no_reason).lossy);

        // The reason is a closed word, so it is removed with the tail it is printed in.
        for (reason, command) in [
            ("comando recortado", "cat big.txt"),
            ("caracteres especiales", "printf '🙂'"),
            ("ruta sensible", "cat ~/.ssh/id_ed25519"),
            ("el texto oculto puede contener sintaxis de shell", "echo [REDACTED]"),
            ("el texto oculto puede ser una ruta", "cat [REDACTED]"),
        ] {
            let card = format!("Claude Code pide permiso para Bash: {command} ({reason}; detalles solo en la terminal; decidir en la terminal)");
            assert_eq!(shown(&card).command, command, "{card}");
            assert!(shown(&card).lossy, "{card}");
        }
    }

    /// The English shapes, both of them, including the reason the English card prints untranslated.
    #[test]
    fn the_english_cards_are_read_the_same_way() {
        let lossless = shown("Codex asks permission: Bash: npm test");
        assert_eq!((lossless.tool.as_str(), lossless.command.as_str(), lossless.lossy), ("Bash", "npm test", false));

        let lossy = shown("Codex asks permission for Bash: npm test (long command; details only in the terminal)");
        assert_eq!(lossy.tool, "Bash");
        assert_eq!(lossy.command, "npm test");
        assert!(lossy.lossy);

        let plain = shown("Codex asks permission: Bash: ls (details only in the terminal)");
        assert_eq!(plain.command, "ls");
        assert!(plain.lossy, "the tail alone marks it, whatever the prefix");
    }

    /// Another tool keeps its own name when it is one, and its summary is the whole shown text (D9).
    #[test]
    fn another_tool_keeps_its_name_and_its_summary() {
        let edit = shown("Claude Code pide permiso para Edit: /home/a/src/main.rs");
        assert_eq!(edit.tool, "Edit");
        assert_eq!(edit.command, "Edit: /home/a/src/main.rs");
        assert!(!edit.lossy);

        // A file edit is always lossy on the island's own card (projection.cjs: FILE_TOOLS), and the tail stays in
        // the summary: D9 strips the tails from the Bash command only.
        let lossy_edit = shown("Claude Code pide permiso para Edit: /home/a/src/main.rs (detalles solo en la terminal; decidir en la terminal)");
        assert_eq!(lossy_edit.tool, "Edit");
        assert!(lossy_edit.lossy);
        assert!(lossy_edit.command.starts_with("Edit: /home/a/src/main.rs"), "{}", lossy_edit.command);

        for (card, tool) in [
            ("Claude Code pide permiso para Write: /tmp/x", "Write"),
            ("Claude Code pide permiso para MultiEdit: /tmp/x", "MultiEdit"),
            ("Claude Code pide permiso para Read: /tmp/x", "Read"),
            ("Claude Code pide permiso para WebFetch: https://example.test", "WebFetch"),
            ("Claude Code pide permiso para WebSearch: cosas", "WebSearch"),
            ("Claude Code pide permiso para Glob: **/*.rs", "Glob"),
            ("Claude Code pide permiso para Grep: fn main", "Grep"),
            ("Claude Code pide permiso para NotebookEdit: /tmp/x.ipynb", "NotebookEdit"),
            ("Claude Code pide permiso para Task: buscar", "Task"),
            ("Codex asks permission: apply_patch", "apply_patch"),
            // «mcp…» is a tool name too (D9): the harness prints `mcp tool Server/Tool`.
            ("Codex asks permission: mcp tool Gmail/Search", "mcp"),
            // The Spanish card translates that prefix, so its first word is no tool name at all.
            ("Claude Code pide permiso para herramienta MCP Gmail/Search", NO_TOOL),
            // An unknown tool name is not invented either.
            ("Claude Code pide permiso para algo raro", NO_TOOL),
        ] {
            assert_eq!(shown(card).tool, tool, "{card}");
        }
    }

    /// A text in no known shape says nothing about the tool: the whole sentence is the command (D9).
    #[test]
    fn an_unknown_shape_keeps_the_whole_sentence() {
        let whole = "Claude Code pide permiso (recortado; detalles solo en la terminal)";
        let read = shown(whole);
        assert_eq!(read.tool, NO_TOOL);
        assert_eq!(read.command, whole);
        assert!(read.lossy, "«recortado» is the lossy marker of that shape");

        for text in ["", "algo", "Codex pregunta: ¿seguimos?", "pi pide permiso para " ] {
            let read = shown(text);
            assert_eq!(read.tool, NO_TOOL, "{text:?}");
            assert!(!read.lossy, "{text:?}");
        }
    }

    /// The tool name is cut off its colon, and the whole text is read only once.
    #[test]
    fn a_tool_name_is_read_without_its_colon() {
        assert_eq!(shown("Claude Code pide permiso para Edit:/tmp/x").tool, "Edit");
        // The earliest prefix wins: a command that happens to contain another one is not re-parsed.
        let card = "Claude Code pide permiso para Bash: echo ' asks permission: x'";
        assert_eq!(shown(card).command, "echo ' asks permission: x'");
    }

    /// The cut is the phone's 500 characters (§8.4), on a character boundary, and it is not a lossy marker.
    #[test]
    fn a_long_command_is_cut_to_the_phones_500_characters() {
        let read = shown(&format!("Claude Code pide permiso para Bash: {}", "é".repeat(900)));
        assert_eq!(read.command.chars().count(), MAX_COMMAND_CHARS);
        assert!(!read.lossy, "a cut is flagged on the wire by its length, not by the terminal marker");
        let short = clip("abc", 2);
        assert_eq!(short, "ab");
    }
}
