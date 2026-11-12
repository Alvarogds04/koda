"use strict";

// K2-13 (T1b, S20): Koda never ships better-sqlite3's native addon. mtcute's MemoryStorage is the only storage the
// daemon ever passes to its client, so this constructor is never called; if some future code path constructed
// SqliteStorage, this throws instead of silently writing the Telegram session to disk.
module.exports = function BetterSqlite3Stub() {
	throw new Error("better-sqlite3 is stubbed out: Koda never writes a Telegram session to disk (S20)");
};
