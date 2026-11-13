# Bash command redaction (`src/redact.cjs`)

**Decision (explicit, human):** the island shows the FULL Bash command, with secrets redacted, so `Allow once` can be offered for commands with arguments. The redacted text goes over the local QP/1 Unix socket (private 0700 directory, 0600 socket, owner-checked) to the island. Raw, unredacted commands are never sent.

`redactCommand(command) -> {text, redactions, spans, pathSpans}`; each secret becomes the fixed marker `[REDACTED]`; `spans` lists the original substrings that were replaced (used by the consent check below) and `pathSpans` the subset that may be a path (rule 8). Passes repeat until stable (max 6), so it is idempotent. Linear time (anchored heads, bounded quantifiers, manual value scanners); tests run 1 MB adversarial inputs under 500 ms each. On an internal error the whole command is hidden.

## Patterns (`PATTERNS` export mirrors this list)

| Group | Id | Redacts |
| --- | --- | --- |
| a | env-assignment | `NAME=VALUE` where NAME contains KEY, TOKEN, SECRET, PASSWORD, PASSWD, PWD, CREDENTIAL, AUTH, COOKIE, SESSION, PRIVATE (case-insensitive); bare, `'..'`, `".."` or `$'..'` values |
| a | json-key | `"secretish-name": value` in JSON bodies, also shell-escaped `\"name\":` |
| b | secret-flag | `--password --passwd --pass --passphrase --passin --passout --token --api-key --apikey --secret --auth --access-token --client-secret --key --credential(s)` and compounds, single-dash too (`-pass`), in `--flag value` and `--flag=value` forms. A value that starts with `-` is taken as the next flag and kept |
| b | login-p | `-p <v>` / `-p<v>` when `login` or `sshpass` appears |
| b | db-attached | `-p<v>` / `-P<v>` after mysql, mariadb, mysqldump, mysqladmin, mysqlpump, psql, pg_dump(all), pg_restore, mongo(sh), redis-cli, sqlplus (command is also lossy) |
| c | http-header | values of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` and any header whose name contains key/token/secret/auth/sig/pass/cred/session/csrf/jwt/cookie, to the closing quote or end of line |
| c | bearer-basic | bare `Bearer <tok>`, `Basic <b64>` |
| c | curl-user | `-u`, `-U`, `--user`, `--proxy-user` value, when curl/wget/xh/http/lftp/ncftp/aria2c appears |
| c | cookie-flag | `-b` / `--cookie` value (cookie strings, `sid=...`) when curl/wget/xh/http/https/httpie appears |
| c | httpie-auth | `-a user:pass` when http/https/xh/httpie appears (`--auth` is covered by secret-flag) |
| b | sql-connect | `user/pass[@db]` connect strings when sqlplus/sqlcl/rman appears; becomes `[REDACTED][@db]` |
| b | token-subcommand | the positional value after `set-access-token-holder`, `print-access-token`, `print-identity-token`, `get-access-token`, `set-identity-token` |
| b | token-word | the unquoted word right after a standalone word `token`, `secret`, `password`, `passwd`, `apikey`, `api-key` (`login token VALUE`, `config set token VALUE`); a value starting with `-` is kept |
| d | url-userinfo | `scheme://user:pass@host` becomes `scheme://[REDACTED]@host` |
| d | url-param | query/fragment values whose name contains token, key, secret, sig, password, passwd, pwd, auth, credential, session, jwt, or is `code` |
| e | token-shapes | `sk-`, `sk-ant-`, `ghp_/gho_/ghu_/ghs_/ghr_`, `github_pat_`, `glpat-`, `xox[abprs]-`, `AKIA/ASIA`, `AIza`, `npm_`, `pypi-`, `SG.x.y`, JWT `eyJ.x.y` |
| e | hex-run | any run of 32 or more hex characters |
| e | base64-run | any run of 40 or more base64/base64url characters; a run containing `/` only when it mixes lower, upper and digits (so long paths survive) |
| f | pem | `-----BEGIN ... PRIVATE KEY-----` to END, or to the end of the string if unterminated |

File paths on permission cards (Write/Edit previews and the paths a suggested rule names) are checked
with `secretPath`: the session folder and the home folder are the user's own paths, so only the part
below them (with its leading separator) is scanned with these rules. On macOS every path starts with `/Users/<Name>`, and a project
folder with a digit in it would otherwise match `base64-run` and hide an ordinary card. A path outside
both folders is scanned whole.

## Lossless-for-display (`allow` may be offered)

Evaluated on the ORIGINAL command. All must hold, otherwise lossy (options `deny` + `terminal` only, fixed reason shown):

1. Tool is `Bash`, `tool_input` a plain object with only `command`/`description`/`timeout`, `command` a non-empty string. (`description` is never shown.)
2. Printable ASCII only (0x20-0x7E): no newline, tab, control, bidi/format/zero-width or non-ASCII. Reason `special characters`.
3. Redacted text <= 380 code points (question <= 500 cp, frame <= 4096 bytes). Reason `long command`.
3b. Cost cap: a command longer than 4096 UTF-16 code units is ALWAYS lossy (`long command`, unless an earlier rule applies inside the prefix). `describeBash` redacts and scans only `command.slice(0, 4096)` (dropping a trailing lone high surrogate); the display comes from that redacted prefix, then the usual truncation. Rationale: the verdict is already lossy (the prefix exceeds the 380 cp display budget), and bounding the work makes the hook path O(4096) instead of O(command size). A secret beyond the cut is never displayed; a span straddling the cut is redacted up to the end of the prefix (unterminated PEM/quote/long run), so the display ends with the marker or before the span. `redactCommand` itself stays pure and linear for direct callers.
4. No literal `[REDACTED]` in the original. Reason `special characters`.
5. No credential path or secret source: `.ssh`, `id_rsa/ed25519/ecdsa/dsa`, `.env`, `.netrc`, `.npmrc`, `.pgpass`, `.aws`, `.gnupg`, `.kube/config`, `.docker/config.json`, `.config/gh`, `/etc/shadow`, `/etc/sudoers`, `auth.json`, `credential` (also `credentials`, `.git-credentials`), lower-case `secret`/`secrets` as a word, path segment or `_secret`/`*secret*` part, `.claude`, `.codex`, `.koda`, `*.pem *.key *.p12 *.pfx`, `cookies`, `pip.conf`, `.gitconfig`, shell rc/profile files (`.bashrc`, `.profile`, `.zshrc`, `/etc/profile` ...), `printenv`, bare `env` as the command (no `VAR=`/command after it), `/proc/*/environ`, `$SSH_AUTH_SOCK`, `gh auth token`, `print-access-token`/`print-identity-token`, `security find-generic-password`, `--login-path`, `kubectl ... --raw`, `vault read|kv get`, `pass show`, `op read`, `gpg --export-secret-keys` (case-insensitive substring match except `secret`, deliberately broad). Reason `touches credential files`.
6. No indirection: `$(`, backticks, `<(`, `>(`, `<<`, `eval`, `source`, `.` as a command, `sudo`, `su`, `doas`, `pkexec`, `base64 -d`, a pipe into sh/bash/zsh/python/perl/node/ruby/php..., inline-code interpreters (`bash|sh|zsh|dash|ksh|fish -c`, `python[3] -c`, `perl -e`, `ruby -e`, `node -e|-p|--eval`, `php -r`, `awk` with `system(`, `env ... sh`), `xargs`, `find` with `-exec|-execdir|-ok|-okdir|-delete`, `dd of=`, `sed -i`, `tee` to a file. Reason `shell indirection`. Plain pipes, redirects, `&&`, `;` are NOT indirection: they are fully visible in the displayed text and stay lossless. A `-p<v>`/`-P<v>` attached to a database client is `special characters`.
6b. No hidden shell syntax: if ANY text replaced by `[REDACTED]` (the `spans`) contains one of `; & | < > ` $ ( ) { } \`, a newline or a carriage return, the command is lossy with the fixed reason `hidden text may contain shell syntax` (false positives such as a password containing `$` are accepted). In addition the header, URL userinfo, escaped-JSON and unterminated PEM spans are clamped to stop at the first unquoted `; & | < >` (or the closing quote), so the visible command keeps its structure. Property-tested: whenever a command is lossless, no span has such a character and the display is `Bash: ` + the redacted text.
6c. Quote parity: scanning the ORIGINAL left to right with a shell-aware quote tracker (single quotes literal; double quotes and `$'..'` with backslash escapes), the command is lossy with the same fixed reason when any replaced span starts and ends in a different quote state, contains an odd number of unescaped `'`/`"`, or when any visible character has a different quote state in the display than in the original. So a visible `; & | < >` is quoted/unquoted in the display exactly as in the original. Root cause also fixed: the bare-scalar JSON value consumes whole quoted chunks (to the matching closing quote) and never stops inside one; an unclosable quote stays visible and only what follows is hidden. Property-tested (6000 quote-heavy commands) with an independent tracker.
7. Also lossy: the redacted text begins with `[REDACTED]` (the command word itself was hidden). Number of redactions does not matter; the question gets ` (secrets hidden)` when it is above 0.
8. Hidden path (K2-08 T1b, human decisions L8 «a» and L10 «a»): lossy with the fixed reason `hidden text may be a path` (Spanish card: «el texto oculto puede ser una ruta») when any replaced span MAY BE A PATH, so over-redaction can never hide the target of a command while still offering `allow`. Applies to Claude and Codex. `redactCommand` returns these spans as `pathSpans`; WHICH text is redacted never changes (text and spans stay byte-identical; a frozen snapshot test and a fuzz against the previous code guard this). A span is path-like, whatever rule hid it, when its ORIGINAL text:
   - contains `/` or `\`; or
   - is exactly `.` or `..` after stripping surrounding quotes (`--token ..`, `--token '.'`); or
   - starts like a path root, optionally after an opening quote: `~` or a drive letter `C:`; or
   - (hex/base64 runs only) sits right next to `/` or `\`, i.e. is a whole path component. There is no `://` exception any more (D-b): `rm -rf ~/x://<40 hex>` shows `~/x://[REDACTED]` but the shell targets `~/x:/<hex>`, so it is lossy.

   Now lossy (D-a: a relative path given as the value of a secret-named option): `--password=foo/../../etc/pw`, `--api-key etc/pw`, `--token=a/b`, `--token "a b/c"`, `--password-file=mystuff/pw.txt`, `PASSWORD=mystuff/pw.txt …`, `curl --key certs/client.crt`, `-H "X-Api-Key: dir/sub/file"`, `--token ..`, `--token .`, `curl -u bob:p/w`; and the verifier's D1 case `rm -rf /home/alvaro/Apps/koda/worktrees/k2-08-codex-respuesta/apps`, shown as `rm -rf [REDACTED]` (before T1b: `allow` with «secretos ocultos»).

   The ONLY exception: the scheme-prefixed value of an `Authorization` / `Proxy-Authorization` header (`Bearer <token>`, `Basic <b64>`) stays approvable even when the token contains `/`: `curl -H "Authorization: Bearer <JWT with />" https://api.example.com`, `curl -H "Authorization: Basic <b64 with />" …`, httpie `Authorization:"Bearer …"`. It holds only when the header name begins a QUOTED shell word (`"Authorization: …` after a space, `=` or `-H`, or httpie `Authorization:"…`), the value starts with `Bearer`/`Basic`, and it has no dot segment (`./`, `../`, `/.`, `/..`). Not exempt (lossy): `-H "Authorization: Bearer ../../x"`, `-H "Authorization: Token a/b"`, an unquoted header, `"/tmp/Authorization: Bearer a/b"`, a bare `Bearer a/b` outside a header, `curl -u` user:pass containing `/`.

   Still approvable (nothing path-like hidden): `sk-…`, `ghp_…` and the other token shapes; standalone hex/base64 runs with no adjacent separator (`echo <40-char base64>`, `mytool verify <40 hex>`, `/tmp/build-<hash>`); URL userinfo `scheme://user:pass@host` (its hidden part cannot contain `/`; one containing `\` is lossy); `--token=abc123`; `curl -u bob:pw`. Commands with nothing hidden are unchanged.

   Accepted cost (L10): a `--token` value (or any secret-named option, variable or non-Authorization header) containing `/` is no longer approvable from the island; AWS secret keys (base64 with `/`) and Slack webhooks / secret URLs with a hidden path were already lossy.

Question texts: lossless `<Agent> asks permission: Bash: <cmd>[ (secrets hidden)]`; lossy `<Agent> asks permission for Bash: <cmd, max 300 cp> (<reason>; details only in the terminal)`.

## Known gaps

- Novel token formats that match no pattern and are not in a secret-named variable/flag/header.
- Secrets in non-secret-named variables inside long strings, e.g. `curl -d 'a=1&pin=4821'`.
- `-p<value>` for tools not in the db list (those commands are shown with the value; only the listed tools are caught).
- Short (< 40 char) base64 and (< 32) hex secrets without a recognisable name.
- Remaining under-redaction: numeric/short secrets without a name (`pin=4821`, short OTP codes), values of unnamed flags, `?d=<base64>` style opaque parameters shorter than the run limits, secrets inside CSV or other structured text in quotes, user/password pairs in non-listed tools.
- Clamped spans can leave a secret tail visible when the secret itself contains `; & | < >` outside quotes (for example `https://u:p;q@host`); the visible command structure is preferred over hiding it.
- Secrets inside files the command reads are not visible to the human either; the credential-path rule only makes such commands lossy.

## False-positive policy

Fail closed: over-redaction is acceptable (`make KEYBOARD=us` shows `KEYBOARD=[REDACTED]`; long hashes are hidden). Over-redaction never makes a command lossless that otherwise was not, but it can hide the command word, which forces lossy, and a hidden path forces lossy too (rule 8).
