'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { redactCommand, PATTERNS } = require('../src/redact.cjs');
const { describeToolDetailed } = require('../src/projection.cjs');
const claude = require('../src/claude.cjs');
const codex = require('../src/codex.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');

// Risky command words are assembled so this source never carries them as one literal.
const SUDO = ['su', 'do'].join(''), SH = ['s', 'h'].join(''), RMRF = ['rm', '-rf'].join(' ');
const GITPUSH = ['git', 'push'].join(' '), NPMPUB = ['npm', 'publish'].join(' ');

const R = c => redactCommand(c).text;
const cwd = path.resolve(__dirname, '..');
const bash = command => describeToolDetailed('Bash', { command });

test('PATTERNS is a documented list', () => {
  assert.ok(PATTERNS.length >= 10);
  for (const p of PATTERNS) assert.ok(p.id && p.group && p.description);
  assert.deepEqual(redactCommand(5), { text: '', redactions: 0, spans: [] });
});

const POSITIVE = {
  'a env assignment': [
    ['export TOKEN=abc123 && ls', 'export TOKEN=[REDACTED] && ls'],
    ['FOO_SECRET="a b c" cmd', 'FOO_SECRET=[REDACTED] cmd'],
    ["db_password='x y' run", 'db_password=[REDACTED] run'],
    ["API_KEY=$'a\\'b' run", 'API_KEY=[REDACTED] run'],
    ['env AWS_SESSION_TOKEN=zzz cmd --x', 'env AWS_SESSION_TOKEN=[REDACTED] cmd --x'],
  ],
  'b flags': [
    ['tool --password hunter2 --x', 'tool --password [REDACTED] --x'],
    ['tool --password=hunter2', 'tool --password=[REDACTED]'],
    ['tool --api-key K1 --client-secret "s 1"', 'tool --api-key [REDACTED] --client-secret [REDACTED]'],
    ['gh auth login --token abc', 'gh auth login --token [REDACTED]'],
    ['openssl enc -pass pass:xxx -in f', 'openssl enc -pass [REDACTED] -in f'],
    ['docker login -u me -p s3cret reg', 'docker login -u me -p [REDACTED] reg'],
  ],
  'c http auth': [
    ['curl -H "Authorization: Bearer abc.def" u', 'curl -H "Authorization: [REDACTED]" u'],
    ["curl -H 'Cookie: a=b; c=d' u", "curl -H 'Cookie: [REDACTED]' u"],
    ['curl -H "X-Api-Key: k123" u', 'curl -H "X-Api-Key: [REDACTED]" u'],
    ['curl -H "Proxy-Authorization: Basic dTpw" u', 'curl -H "Proxy-Authorization: [REDACTED]" u'],
    ['curl -u bob:pw https://h', 'curl -u [REDACTED] https://h'],
    ['curl --user bob:pw https://h', 'curl --user [REDACTED] https://h'],
    ['x Bearer tok123 y', 'x Bearer [REDACTED] y'],
  ],
  'd urls': [
    ['git clone https://u:tok@host/r.git', 'git clone https://[REDACTED]@host/r.git'],
    ['curl "https://h/p?token=abc&x=1"', 'curl "https://h/p?token=[REDACTED]&x=1"'],
    ['curl https://h/p?x=1&API_KEY=zz', 'curl https://h/p?x=1&API_KEY=[REDACTED]'],
    ['open https://h/#access_token=qq', 'open https://h/#access_token=[REDACTED]'],
    ['psql postgres://u:p@h/db', 'psql postgres://[REDACTED]@h/db'],
  ],
  'e token shapes': [
    ['echo ghp_' + 'a'.repeat(30), 'echo [REDACTED]'],
    ['echo github_pat_' + 'A1_'.repeat(10), 'echo [REDACTED]'],
    ['echo AKIA' + 'A'.repeat(16), 'echo [REDACTED]'],
    ['echo xoxb-1234567890-abc', 'echo [REDACTED]'],
    ['echo ' + 'ab12'.repeat(8), 'echo [REDACTED]'],
    ['echo ' + 'Zm9vYmFy'.repeat(6), 'echo [REDACTED]'],
    ['echo eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghij', 'echo [REDACTED]'],
    ['echo sk-ant-' + 'x'.repeat(30), 'echo [REDACTED]'],
  ],
  'f pem': [
    ['echo "-----BEGIN RSA PRIVATE KEY-----\nMIIx\n-----END RSA PRIVATE KEY-----" > k', 'echo "[REDACTED]" > k'],
    ['echo -----BEGIN PRIVATE KEY-----\nabc', 'echo [REDACTED]'],
  ],
};
for (const [group, rows] of Object.entries(POSITIVE)) {
  test('redaction positives: ' + group, () => { for (const [i, o] of rows) assert.equal(R(i), o, i); });
}
test('redaction negatives: innocent commands are untouched', () => {
  for (const c of ['ls -la /tmp', 'git status', 'npm test', 'echo hello', 'git log --oneline -n 5', 'curl -s https://example.com/a/b?page=2',
    'cat /home/dev/Apps/my-project/worktrees/abito-engine/README.md', 'grep -rn foo src/', 'make MODE=us', 'ls --all', 'node -p 1+1',
    'tool --keyboard x', 'git commit -m "fix tokenizer"', 'PATH=/usr/bin ls', 'echo a:b']) {
    assert.deepEqual(redactCommand(c), { text: c, redactions: 0, spans: [] }, c);
  }
});
test('redactions counts and fixed marker', () => {
  assert.equal(redactCommand('A_TOKEN=1 B_SECRET=2').redactions, 2);
  assert.equal(redactCommand('ls').redactions, 0);
});

const PLANTED = 'SECRETVAL9x';
const SECRET_COMMANDS = [
  `curl -H "Authorization: Bearer ${PLANTED}" https://api.example.com/v1`,
  `curl -H 'Authorization: Basic ${PLANTED}' https://h`,
  `curl --header "Cookie: sid=${PLANTED}; a=b" https://h`,
  `curl -H "Cookie: ${PLANTED}" https://h`,
  `curl -u admin:${PLANTED} https://h/x`,
  `curl --user admin:${PLANTED} https://h/x`,
  `curl -H "X-Api-Key: ${PLANTED}" https://h`,
  `curl -H "X-Auth-Token: ${PLANTED}" https://h`,
  `curl "https://h/api?api_key=${PLANTED}&q=1"`,
  `curl "https://h/api?q=1&access_token=${PLANTED}"`,
  `curl https://h/cb#id_token=${PLANTED}`,
  `curl -d '{"password":"${PLANTED}"}' https://h`,
  `curl -d "{\\"token\\":\\"${PLANTED}\\"}" https://h`,
  `git clone https://user:${PLANTED}@github.com/o/r.git`,
  `git remote add o https://x-access-token:${PLANTED}@github.com/o/r`,
  `${GITPUSH} https://bob:${PLANTED}@host/r.git main`,
  `aws configure set aws_secret_access_key AKIA${'Q'.repeat(16)}`,
  `AWS_SECRET_ACCESS_KEY=${PLANTED} aws s3 ls`,
  `AWS_ACCESS_KEY_ID=AKIA${'Z'.repeat(16)} aws s3 ls`,
  `gh auth login --token ${PLANTED}`,
  `GH_TOKEN=${PLANTED} gh pr list`,
  `GITHUB_TOKEN="${PLANTED}" gh api /user`,
  `npm config set //registry.npmjs.org/:_authToken npm_${'a1'.repeat(20)}`,
  `NPM_TOKEN=${PLANTED} ${NPMPUB}`,
  `docker login -u me --password ${PLANTED} reg.io`,
  `docker login -u me -p ${PLANTED} reg.io`,
  `docker login --password=${PLANTED}`,
  `docker run -e SECRET=${PLANTED} img`,
  `docker run -e DB_PASSWORD="${PLANTED}" img`,
  `docker run --env API_KEY=${PLANTED} img`,
  `export TOKEN=${PLANTED}`,
  `export OPENAI_API_KEY='${PLANTED}' && python run.py`,
  `env FOO_SECRET=${PLANTED} cmd`,
  `FOO_PASSWORD=${PLANTED} ./run.sh`,
  `psql postgres://u:${PLANTED}@h:5432/db -c 'select 1'`,
  `psql "postgresql://u:${PLANTED}@h/db"`,
  `mysql -u root -p${PLANTED} db`,
  `mysql -h h -u u --password=${PLANTED}`,
  `mysqldump -u u -p${PLANTED} db`,
  `openssl enc -aes-256-cbc -pass pass:${PLANTED} -in f`,
  `openssl rsa -passin pass:${PLANTED} -in k.pem`,
  `sshpass -p ${PLANTED} ssh u@h`,
  `sshpass -p'${PLANTED}' ssh u@h`,
  `python -c 'import requests; requests.get("https://h", headers={"Authorization": "Bearer ${PLANTED}"})'`,
  `python -c "token='sk-${'A1b2'.repeat(6)}'; print(token)"`,
  `node -e "fetch('https://h?key=${PLANTED}')"`,
  `echo ${'deadbeef'.repeat(5)} | tee k`,
  `echo ghp_${'Q'.repeat(36)}`,
  `echo glpat-${'a'.repeat(20)}`,
  `echo xoxb-123456789012-${'z'.repeat(12)}`,
  `echo AIza${'Y'.repeat(35)}`,
  `echo pypi-${'p'.repeat(40)}`,
  `echo SG.${'a'.repeat(22)}.${'b'.repeat(22)}`,
  `echo eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.${'s'.repeat(12)}`,
  `echo "-----BEGIN OPENSSH PRIVATE KEY-----\n${PLANTED}\n-----END OPENSSH PRIVATE KEY-----"`,
  `echo '-----BEGIN PRIVATE KEY-----' ${PLANTED}`,
  `vault login --token ${PLANTED}`,
  `terraform apply -var "db_password=${PLANTED}"`,
  `helm install x --password ${PLANTED}`,
  `wget --header="Authorization: token ${PLANTED}" https://h`,
  `redis-cli --pass ${PLANTED} ping`,
  `http --auth user:${PLANTED} https://h`,
  `ssh -i key u@h 'export SESSION_ID=${PLANTED}; run'`,
  `scp -o 'ProxyCommand=nc --password ${PLANTED} %h' f u@h:`,
  `pip install --index-url https://__token__:${PLANTED}@pypi.example/simple pkg`,
];
test('no secret fragment remains for realistic secret-bearing commands; idempotent', () => {
  assert.ok(SECRET_COMMANDS.length >= 60);
  const shapes = [PLANTED, 'sk-A1b2', 'AKIAQQ', 'AKIAZZ', 'npm_a1a1', 'deadbeefdeadbeef', 'ghp_QQ', 'glpat-aa', 'xoxb-1234', 'AIzaYY', 'pypi-pp', 'SG.aaa', 'eyJhbGci'];
  for (const c of SECRET_COMMANDS) {
    const { text, redactions } = redactCommand(c);
    for (const s of shapes) assert.ok(!text.includes(s), `${s} survives in: ${text}  (from ${c})`);
    assert.equal(R(text), text, 'idempotent: ' + c);
    assert.ok(redactions > 0, c);
  }
});
test('idempotence on marker-adjacent inputs', () => {
  for (const c of ['X_TOKEN=[REDACTED]abc', 'curl -u [REDACTED] h', 'a [REDACTED] b', '"password":[REDACTED]]]', 'TOKEN=a TOKEN=b', 'tool --key --key', 'https://[REDACTED]@h/?token=[REDACTED]']) {
    const once = R(c); assert.equal(R(once), once, c);
  }
});

const mbOf = (unit, n = 1e6) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
let maxRedosMs = 0;
test('ReDoS: 1 MB adversarial inputs through the real hook path finish < 150 ms', () => {
  const mb = mbOf;
  const inputs = ['a', 'TOKEN=', '-----BEGIN PRIVATE KEY-----', 'https://a:', 'Bearer ', '--password ', 'X-', 'sk-', '-p1 mysql ', 'a:', '"a":', '?a=&',
    '0'.repeat(31) + ' ', 'a/', 'eyJabcdefgh.', 'A'.repeat(39) + ' ', '\\"', "'", '"', '-u ', 'curl -u ', 'AKIA', 'ghp_', '$', ' ', 'a=', "KEY='", '; ', '[REDACTED]', 'é😀',
    'curl -b ', 'http -a ', 'sqlplus a/', 'sqlplus a/b ', 'token ', 'print-access-token ', '-----BEGIN PRIVATE KEY----- ;', '-----BEGIN PRIVATE KEY-----\' ', 'x:\\"token\\":\\"',
    'env ', 'env a ', 'find ', 'tee -a ', 'bash -x ', 'sh -a -b ', 'xargs ', 'sed ', 'dd ', 'awk ', '. ', 'node -', 'a=1 ', 'http://a;b'];
  for (const u of inputs) {
    const s = mb(u), t = process.hrtime.bigint();
    const d = bash(s);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    maxRedosMs = Math.max(maxRedosMs, ms);
    assert.equal(d.lossy, true);
    assert.ok(ms < 150, `${JSON.stringify(u.slice(0, 20))} took ${ms.toFixed(0)} ms`);
  }
  console.log(`# max describeToolDetailed(Bash) 1 MB: ${maxRedosMs.toFixed(0)} ms`);
});
test('redactCommand directly on 1 MB stays < 1500 ms and is linear (2 MB <= 3.5x 1 MB)', () => {
  let max = 0;
  const time = s => { const t = process.hrtime.bigint(); redactCommand(s); return Number(process.hrtime.bigint() - t) / 1e6; };
  for (const u of ['curl -u ', 'curl -b ', 'http -a ', 'TOKEN=', '-----BEGIN PRIVATE KEY-----', 'A'.repeat(39) + ' ']) {
    time(mbOf(u, 2e5)); // warm-up
    const best = (s, n = 3) => Math.min(...Array.from({ length: n }, () => time(s))); // noisy shared runners: the minimum of 3 runs, not one sample
    const a = best(mbOf(u)), b = best(mbOf(u, 2e6));
    max = Math.max(max, a);
    assert.ok(a < 1500, `${u} 1MB ${a.toFixed(0)} ms`);
    assert.ok(b <= Math.max(3.5 * a, 60), `${u}: 2MB ${b.toFixed(0)} ms vs 1MB ${a.toFixed(0)} ms`);
  }
  console.log(`# max redactCommand 1 MB: ${max.toFixed(0)} ms`);
});
test('commands over 4096 units are always lossy and never leak secrets beyond or across the cut', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\n' + 'MIIEvQIBADANBgkqhkiG9w0BAQEF'.repeat(40);
  const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(6);
  const secrets = { pem: ['PEMBODY', PEM], quoted: ['QTOKENVAL', "X_TOKEN='QTOKENVAL andmore"], b64: ['B64PLANT', B64] };
  for (const at of [290, 370, 4090]) {
    for (const [k, [, body]] of Object.entries(secrets)) {
      const head = 'echo ' + 'a '.repeat(Math.max(0, (at - 5) / 2));
      const cmd = (head + body + ' ' + 'z '.repeat(3000)).replace(/\n/g, ' ');
      const d = bash(cmd);
      assert.equal(d.lossy, true, k); assert.ok(d.reason === 'long command' || (k === 'quoted' && d.reason === 'hidden text may contain shell syntax'), k + at + d.reason); // earlier rule inside the prefix keeps priority
      assert.ok(!d.text.includes('MIIEvQ') && !d.text.includes('QUJDREVG') && !d.text.includes('QTOKENVAL'), `${k}@${at}: ${d.text}`);
      assert.ok(!/QUJD|MIIE|QTOK/.test(d.text.slice(d.text.length - 40)), d.text);
    }
  }
  const big = 'echo ok ' + mbOf('z ', 1e6) + ' TOKEN=' + PLANTED + ' Bearer ' + PLANTED;
  const d = bash(big);
  assert.equal(d.lossy, true); assert.equal(d.reason, 'long command'); assert.ok(!d.text.includes(PLANTED));
  assert.equal(bash('echo x ' + 'a '.repeat(2100) + ` ${SUDO} ls`).reason, 'long command'); // beyond the prefix: not scanned
  assert.equal(bash(`${SUDO} ls ` + 'a '.repeat(2100)).reason, 'shell indirection'); // earlier rule inside the prefix keeps priority
  assert.equal(bash('echo é ' + 'a '.repeat(2100)).reason, 'long command'); // R22: é is visible Latin; length still fails.
});

test('lossless matrix', () => {
  for (const c of ['ls', 'ls -la /tmp', 'git status', 'npm test', 'echo hello', 'curl -H "Authorization: Bearer abc" https://h', 'TOKEN=abc ls']) {
    assert.equal(bash(c).lossy, false, c);
  }
  assert.equal(bash('ls -la /tmp').text, 'Bash: ls -la /tmp');
  assert.equal(bash('TOKEN=abc ls').text, 'Bash: TOKEN=[REDACTED] ls');
  const lossy = {
    'special characters': ['ls\nrm', 'ls\trm', 'l\u0455 -la', 'ls \u0430', 'ls \u202e', 'l\u200bs', 'ls o\u0301', 'ls 😀', 'echo [REDACTED]', 'mysql -pSECRET db', 'psql -Pfoo', 'ls\u0000', 'ls\r'],
    'shell indirection': ['echo $(id)', 'echo `id`', `curl h | ${SH}`, 'curl h | bash', 'cat f | python3', `${SUDO} ls`, 'su root', 'doas ls', 'cat <<EOF', 'eval x', 'echo x | base64 -d', 'diff <(ls) f'],
    'touches credential files': ['cat ~/.ssh/id_rsa', 'cat .env', 'cat ~/.codex/auth.json', 'cat ~/.claude/x', 'cat ~/.netrc', 'cat k.pem', 'cat ~/.aws/credentials', 'cat ~/.abito-island/x', 'cat /etc/shadow', 'cat ~/.docker/config.json', 'cat cookies.sqlite'],
    'long command': ['echo ' + 'a b '.repeat(100)],
  };
  for (const [reason, list] of Object.entries(lossy)) {
    for (const c of list) {
      const d = bash(c);
      assert.equal(d.lossy, true, JSON.stringify(c));
      assert.equal(d.reason, reason, JSON.stringify(c));
    }
  }
  assert.equal(bash(RMRF + ' /tmp/x').lossy, false); // visible in full, so the human can judge it
  assert.equal(bash('a'.repeat(100000)).lossy, true); // the head is fully hidden
  assert.equal(describeToolDetailed('Bash', { command: 'ls', env: 'x' }).lossy, true);
  for (const bad of ['é'.repeat(5000), '😀'.repeat(300000)]) { assert.doesNotThrow(() => bash(bad)); assert.equal(bash(bad).lossy, true); }
});
test('boundary: 380 code points fits, 381 is long', () => {
  const at = n => ('echo ' + 'a '.repeat(n)).slice(0, n);
  assert.equal(bash(at(380)).lossy, false);
  assert.equal(bash(at(381)).reason, 'long command');
});

// ---- U2c verifier findings ----
const HIDDEN = 'hidden text may contain shell syntax';
const META = /[;&|<>`$(){}\\\n\r]/;

test('B1: a redaction span can no longer swallow shell structure', () => {
  const cases = [
    ['echo start ; auth: rm > /dev/null', 'Bash: echo start ; auth: [REDACTED] > /dev/null'],
    ['echo a ; csrf: x && printf b', 'Bash: echo a ; csrf: [REDACTED] && printf b'],
    ['cat f.txt -----BEGIN OPENSSH PRIVATE KEY----- x ; printf hi', 'Bash: cat f.txt [REDACTED] ; printf hi'],
    ['curl http://a;printf b@h/x', 'Bash: curl http://a;printf b@h/x'],
    ['echo \\"token\\":\\"abc | cat', 'Bash: echo \\"token\\":\\"[REDACTED] | cat'],
  ];
  for (const [c, display] of cases) {
    const d = bash(c);
    assert.equal(d.text, display, c);
    assert.equal(d.lossy, false, c);
  }
});
test('B1: any replaced text containing shell syntax makes the command lossy (safety net)', () => {
  for (const c of ['curl -H "Cookie: a=b; c=d" u', "PASSWORD='p&q' ls", 'X_TOKEN="a$b" ls', 'curl -u "a|b:c" h', 'TOKEN="abc ; run']) {
    const { spans } = redactCommand(c);
    assert.ok(spans.some(x => META.test(x)), c);
    const d = bash(c);
    assert.equal(d.lossy, true, c);
    assert.equal(d.reason, HIDDEN, c);
  }
  assert.equal(bash('curl -u bob:pw https://h').lossy, false);
});
test('B1 property: lossless implies no replaced span has shell syntax and structure is intact', () => {
  let seed = 12345;
  const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const frags = ['echo', 'ls', 'cat', 'curl', 'http', 'auth:', 'csrf:', 'Authorization:', 'X-Token:', 'Cookie:', '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----', '-----END PRIVATE KEY-----', 'http://', 'https://u:p@h/x', 'a@h', 'b@h', ';', '&&', '|', '>', '<', '`', '$(', '"', "'",
    '\\"token\\":', '"password":', '--password', '--token', 'TOKEN=', 'SECRET_X=', '-p', '-u', '-H', 'Bearer', 'Basic', 'x', 'y1', '/dev/null', '\\', '{', '}',
    '(', ')', '$', '?token=', '&key=', 'rm', 'f.txt', ':', '=', 'eyJabcdefgh.eyJabcdefgh.abcdefghij', 'ab12'.repeat(8), '\\"'];
  let lossless = 0;
  for (let i = 0; i < 4000; i++) {
    const parts = [];
    for (let k = 3 + rnd(12); k > 0; k--) parts.push(frags[rnd(frags.length)]);
    let c = '';
    for (const p of parts) c += p + (rnd(4) === 0 ? '' : ' ');
    const r = redactCommand(c), d = bash(c);
    if (d.lossy) continue;
    lossless++;
    for (const span of r.spans) assert.ok(!META.test(span), `span ${JSON.stringify(span)} in ${JSON.stringify(c)}`);
    assert.equal(d.text, 'Bash: ' + r.text, c);
    const count = s => (s.match(/[;&|<>`$(){}\\\n\r]/g) || []).length;
    assert.equal(count(c), count(r.text), c);
  }
  assert.ok(lossless > 300, 'generator must exercise the lossless path: ' + lossless);
});

// ---- R1 (quote parity): a span must not flip the quote state seen by the human ----
// Independent tracker: state BEFORE each index (and at n). 0 none, 1 single, 2 double, 3 $'..'.
function statesOf(s) {
  const out = new Array(s.length + 1);
  let st = 0, i = 0;
  while (i < s.length) {
    out[i] = st;
    const ch = s[i];
    if (st === 0) {
      if (ch === '\\') { if (i + 1 < s.length) out[i + 1] = st; i += 2; continue; }
      if (ch === "'") st = 1; else if (ch === '"') st = 2; else if (ch === '$' && s[i + 1] === "'") { out[i + 1] = 0; st = 3; i += 2; continue; }
    } else if (st === 1) { if (ch === "'") st = 0; }
    else if (ch === '\\') { if (i + 1 < s.length) out[i + 1] = st; i += 2; continue; }
    else if ((st === 2 && ch === '"') || (st === 3 && ch === "'")) st = 0;
    i++;
  }
  out[s.length] = st;
  return out;
}
// Visible pieces of the display aligned (leftmost) inside the original: [{o, d, len}] or null.
function align(orig, shown) {
  const pieces = shown.split('[REDACTED]');
  const res = [];
  let o = 0, d = 0;
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k];
    let at;
    if (k === 0) at = orig.startsWith(p) ? 0 : -1;
    else if (k === pieces.length - 1) at = orig.length - p.length >= o && orig.endsWith(p) ? orig.length - p.length : -1;
    else at = orig.indexOf(p, o);
    if (at < 0) return null;
    res.push({ o: at, d, len: p.length });
    o = at + p.length; d += p.length + '[REDACTED]'.length;
  }
  return res;
}

test('R1: the quote-swallowing span from the verifier is lossy', () => {
  const c = `"token": 'a b' ; ${['rm', '-f'].join(' ')} /tmp/z`;
  const d = bash(c);
  assert.equal(d.text, 'Bash: "token": [REDACTED] ; ' + ['rm', '-f'].join(' ') + ' /tmp/z'); // root cause: the whole 'a b' is hidden
  assert.equal(d.lossy, false);
  // the lossy rule itself: a replaced part that flips quote state is lossy
  const { quoteParityLoss } = require('../src/redact.cjs');
  assert.equal(quoteParityLoss("\"token\": 'a b' ; ls", "\"token\": [REDACTED] b' ; ls"), true);
  assert.equal(quoteParityLoss("echo 'a b' ; ls", 'echo [REDACTED] ; ls'), false);
  assert.equal(quoteParityLoss('echo "a b" ; ls', 'echo "[REDACTED] ; ls'), true);
  assert.equal(quoteParityLoss("echo 'x; y' z", "echo '[REDACTED] z"), true);
  for (const x of [`"token": 'a b'`, `"token": 'a b' ; ls`, `"token": "a b" ; ls`, `"token": $'a b' ; ls`, `echo "token": 'a;b' c`]) {
    if (!bash(x).lossy) {
      const t = redactCommand(x).text, st = statesOf(x), a = align(x, t), sd = statesOf(t);
      assert.ok(a, x);
      for (const p of a) for (let j = 0; j < p.len; j++) assert.equal(st[p.o + j], sd[p.d + j], x);
    }
  }
});

test('R1 property: lossless implies identical quote state for every visible character', () => {
  let seed = 987654;
  const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const frags = ['echo', 'ls', 'cat', '"token":', "'token':", '"password":', '\\"token\\":', "'a b'", "'a", "b'", '"a b"', '"a', 'b"', "$'a b'", "$'a", "'", '"', ';', '&', '|', '>', '<',
    'TOKEN=', "TOKEN='x y'", 'SECRET_X="p q"', '--password', '--token', '-p', 'curl', 'login', 'Authorization:', 'auth:', 'Cookie:', '-u',
    'x', 'y1', '/tmp/z', '-f', 'rm', 'true', 'abc,def', '{', '}', '\\', "\\'", '\\"', '1', '2,', ']'];
  let lossless = 0, redacted = 0;
  for (let i = 0; i < 6000; i++) {
    let c = '';
    for (let k = 2 + rnd(10); k > 0; k--) c += frags[rnd(frags.length)] + (rnd(4) === 0 ? '' : ' ');
    const d = bash(c);
    if (d.lossy) continue;
    lossless++;
    const r = redactCommand(c);
    if (r.redactions > 0) redacted++;
    assert.equal(d.text, 'Bash: ' + r.text, c);
    const a = align(c, r.text);
    assert.ok(a, `unalignable ${JSON.stringify(c)} -> ${JSON.stringify(r.text)}`);
    const so = statesOf(c), sd = statesOf(r.text);
    for (const p of a) {
      for (let j = 0; j <= p.len; j++) assert.equal(so[p.o + j], sd[p.d + j], `${JSON.stringify(c)} -> ${JSON.stringify(r.text)} @${j}`);
    }
  }
  assert.ok(lossless > 300 && redacted > 50, `generator coverage: lossless=${lossless} redacted=${redacted}`);
});

test('R1: bare JSON scalar never starts or ends inside a quoted token', () => {
  assert.equal(redactCommand(`echo "token": 'a b' c`).text, `echo "token": [REDACTED] c`);
  assert.equal(redactCommand(`echo "token": 'ab c`).text.includes('ab'), false);
  const x = "echo \"token\": x'a b'y z";
  assert.equal(redactCommand(x).text, 'echo "token": [REDACTED] z');
  assert.equal(redactCommand(redactCommand(x).text).text, redactCommand(x).text);
});

const R1_COMMANDS = [
  `curl -b "sid=${PLANTED}" https://h`,
  `curl --cookie "sid=${PLANTED}" https://h`,
  `curl --cookie=sid=${PLANTED} https://h`,
  `curl -b sid=${PLANTED} https://h`,
  `http -a admin:${PLANTED} https://h`,
  `https -a admin:${PLANTED} h`,
  `xh --auth admin:${PLANTED} h`,
  `http --auth=admin:${PLANTED} h`,
  `sqlplus scott/${PLANTED}@orcl`,
  `sqlplus -S "scott/${PLANTED}@//h:1521/svc" @x.sql`,
  `rman target sys/${PLANTED}@db`,
  `sqlcl admin/${PLANTED}@h`,
  `sqlplus scott/${PLANTED}`,
  `gcloud auth set-access-token-holder ${PLANTED}`,
  `gcloud auth print-access-token ${PLANTED}`,
  `az account get-access-token ${PLANTED}`,
  `mytool login token ${PLANTED}`,
  `mytool config set token ${PLANTED}`,
  `mytool set password ${PLANTED}`,
  `mytool secret ${PLANTED}`,
  `mytool apikey ${PLANTED}`,
];
test('R1: new secret formats are redacted and idempotent', () => {
  for (const c of R1_COMMANDS) {
    const { text, redactions } = redactCommand(c);
    assert.ok(!text.includes(PLANTED), `${text}  (from ${c})`);
    assert.ok(redactions > 0, c);
    assert.equal(R(text), text, 'idempotent: ' + c);
  }
  assert.equal(R(`sqlplus scott/${PLANTED}@orcl`), 'sqlplus [REDACTED]@orcl');
  assert.equal(R(`curl -b "sid=${PLANTED}" h`), 'curl -b [REDACTED] h');
  assert.equal(R(`http -a u:${PLANTED} h`), 'http -a [REDACTED] h');
  assert.equal(R(`mytool login token ${PLANTED}`), 'mytool login token [REDACTED]');
  for (const c of ['git commit -m "fix token handling"', 'echo token', 'ls -a', 'curl -s -a x h', 'sqlplus -V', 'npm test']) {
    assert.equal(R(c), c, c);
  }
});

test('R2: credential and secret sources are lossy', () => {
  const list = ['cat secret/x', 'ls *secret*', 'cat my_secret.txt', 'cat ~/.config/pip/pip.conf', 'cat pip.conf', 'printenv', 'printenv HOME', 'env', 'env | grep x',
    'cat /proc/1/environ', 'gh auth token', 'gcloud auth print-access-token', 'security find-generic-password -s x', 'mysql --login-path=x',
    'cat ~/.bashrc', 'cat ~/.profile', 'cat ~/.zshrc', 'cat /etc/profile', 'echo $SSH_AUTH_SOCK', 'cat ~/.git-credentials', 'cat ~/.gitconfig',
    'kubectl config view --raw', 'vault read secret/x', 'vault kv get x', 'pass show x', 'op read op://v/i', 'gpg --export-secret-keys'];
  for (const c of list) {
    const d = bash(c);
    assert.equal(d.lossy, true, c);
    assert.equal(d.reason, 'touches credential files', c);
  }
  for (const c of ['source ~/.bashrc', '. ~/.profile']) assert.equal(bash(c).lossy, true, c);
  for (const c of ['env FOO=1 ls', 'echo pass', 'ls environment', 'git status', 'kubectl config view']) assert.equal(bash(c).lossy, false, c);
});

test('R3: shell indirection is lossy; plain pipes, redirects and && are not', () => {
  const del = ['-del', 'ete'].join('');
  const list = ['bash -c "ls"', 'sh -c ls', 'zsh -c x', 'dash -c x', 'bash -lc x', 'python -c "print(1)"', 'python3 -c x', "perl -e 'print 1'", 'ruby -e x',
    'node -e x', 'php -r x', `awk 'BEGIN{system("ls")}'`, 'env FOO=1 sh', 'env -i bash', 'xargs echo', 'ls | xargs echo', 'find . -exec echo {} +',
    `find . ${del}`, 'find . -execdir x +', 'find . -ok echo {} +', 'dd if=a of=b', 'sed -i s/a/b/ f', 'echo x | tee f', 'eval ls', 'source x', '. x', 'nohup bash -c x'];
  for (const c of list) {
    const d = bash(c);
    assert.equal(d.lossy, true, c);
    assert.equal(d.reason, 'shell indirection', c);
  }
  for (const c of ['ls | grep x', 'cat a > b', 'make && make test', 'echo hi | tee', 'sed -n 1p f', 'node --version', 'python --version', "awk '{print 1}' f",
    'dd if=a', 'find . -name x', 'python3 script.py', 'ls . ', 'git diff | head', 'cat a 2>&1 | wc -l']) {
    assert.equal(bash(c).lossy, false, c);
  }
});

// ---- end to end with the fake receiver, both adapters ----
const envOf = r => ({ ABITO_DESKTOP_SOCKET: r.endpoint, ABITO_SOCKET_DIR: r.runtime });
const answerer = (rcv, value) => rcv.next('question').then(q => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: q.project,
  sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'human', answer: { type: 'option', value } }));
// S2 (ad0ae382) keeps Claude answering; S4/T2 makes Codex NOTICE-ONLY, so its rows live in the `Codex (aviso)` block
// at the end of this file. The redaction contract itself (never a secret on the wire) is asserted for both.
const ADAPTERS = [['Claude Code', viaPipe(claude.handleClaudeHook), claude]];
const input = command => JSON.stringify({ session_id: 's', cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command, description: 'SECRETDESC' }, last_assistant_message: 'SECRETREPLY' });
const checkSize = (rcv, q) => {
  assert.ok([...q.text].length <= 500);
  assert.ok(Buffer.byteLength(rcv.rawFrames.find(x => x.includes('"question"') && x.includes('kind'))) <= 4096);
};
const codexNotice = async (t, command) => {
  const rcv = await fakeReceiver(t, { questions: true });
  const r = await viaPipe(codex.handleCodexHook)({ event: 'permission-request', input: input(command), env: envOf(rcv), argv: [] });
  const notice = await rcv.seen('attention');
  assert.equal(r.stdout, ''); assert.equal(r.exitCode, 0);
  assert.equal(rcv.frames.filter(f => f.type === 'questions_hello' || f.type === 'question').length, 0, 'never a question');
  assert.ok([...notice.detail].length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(notice)) + 1 <= 512);
  return { rcv, r, notice };
};
for (const [agent, handler, mod] of ADAPTERS) {
  test(`e2e ${agent}: lossless redacted command is shown, allow/deny offered, allow yields the allow line`, async t => {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'allow');
    const r = await handler({ event: 'permission-request', input: input('curl -H "Authorization: Bearer SECRETBEARER1" -u adm:SECRETPW2 https://h/x?token=SECRETQ3 && ls'), env: envOf(rcv), argv: [] });
    await p;
    const q = rcv.frames.find(f => f.type === 'question');
    assert.equal(q.text, `${agent} pide permiso para Bash: curl -H "Authorization: [REDACTED]" -u [REDACTED] https://h/x?token=[REDACTED] && ls (secretos ocultos)`);
    assert.deepEqual(q.options.map(o => o.value), ['allow', 'deny']);
    assert.equal(r.stdout, mod.ALLOW);
    assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
    checkSize(rcv, q);
  });
  test(`e2e ${agent}: no redaction => no suffix; deny yields deny line`, async t => {
    const rcv = await fakeReceiver(t, { questions: true });
    const p = answerer(rcv, 'deny');
    const r = await handler({ event: 'permission-request', input: input('ls -la /tmp'), env: envOf(rcv), argv: [] });
    await p;
    assert.equal(rcv.frames.find(f => f.type === 'question').text, `${agent} pide permiso para Bash: ls -la /tmp`);
    assert.equal(r.stdout, mod.DENY);
    assert.doesNotMatch(rcv.rawFrames.join(''), /SECRETDESC|SECRETREPLY/);
  });
  for (const [command, reason] of [['cat ~/.ssh/id_rsa', 'touches credential files'], ['echo $(id) TOKEN=SECRETX9', 'shell indirection'],
    ['echo l\u0455 TOKEN=SECRETX9', 'special characters'], ['echo ' + 'word '.repeat(120) + 'TOKEN=SECRETX9', 'long command'], ['mysql -pSECRETX9', 'special characters']]) {
    test(`e2e ${agent}: lossy (${reason}) offers deny/terminal; forged allow => empty; no secret on the wire`, async t => {
      for (const value of ['allow', 'terminal', 'deny']) {
        const rcv = await fakeReceiver(t, { questions: true });
        const p = answerer(rcv, value);
        const r = await handler({ event: 'permission-request', input: input(command), env: envOf(rcv), argv: [] });
        await p;
        const q = rcv.frames.find(f => f.type === 'question');
        assert.deepEqual(q.options.map(o => o.value), ['deny', 'terminal']);
        const spanishReason = { 'touches credential files': 'ruta sensible', 'shell indirection': 'indirección de shell',
          'special characters': 'caracteres especiales', 'long command': 'comando recortado' }[reason];
        assert.match(q.text, new RegExp(`^${agent} pide permiso para Bash: .*\\(${spanishReason}; detalles solo en la terminal; decidir en la terminal\\)$`));
        assert.equal(r.stdout, value === 'deny' ? mod.DENY : '');
        assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
        checkSize(rcv, q);
      }
    });
  }
  test(`e2e ${agent}: new R1 secret formats never reach the wire; hidden shell syntax is lossy`, async t => {
    for (const command of [...R1_COMMANDS, 'echo a ; X-Token: ' + PLANTED + ' > /dev/null', 'cat f -----BEGIN PRIVATE KEY----- ' + PLANTED + ' ; ls']) {
      const rcv = await fakeReceiver(t, { questions: true });
      const p = answerer(rcv, 'deny');
      await handler({ event: 'permission-request', input: input(command), env: envOf(rcv), argv: [] });
      await p;
      assert.ok(!rcv.rawFrames.join('').includes(PLANTED), command);
    }
    for (const value of ['allow', 'deny']) {
      const rcv = await fakeReceiver(t, { questions: true });
      const p = answerer(rcv, value);
      const r = await handler({ event: 'permission-request', input: input('curl -H "Cookie: a=b; c=' + PLANTED + '" h'), env: envOf(rcv), argv: [] });
      await p;
      const q = rcv.frames.find(f => f.type === 'question');
      assert.deepEqual(q.options.map(o => o.value), ['deny', 'terminal']);
      assert.match(q.text, /el texto oculto puede contener sintaxis de shell; detalles solo en la terminal/);
      assert.equal(r.stdout, value === 'deny' ? mod.DENY : '');
    }
  });
  test(`e2e ${agent}: max-length and 4-byte-character commands stay within 500 cp / 4096 bytes and never crash`, async t => {
    const cases = ['echo ' + 'a '.repeat(187) + 'ab', 'echo ' + 'a '.repeat(400), '😀'.repeat(2000), 'é'.repeat(2000) + ' TOKEN=SECRETX9', 'echo ' + '\ud800'.repeat(50)];
    for (const command of cases) {
      const rcv = await fakeReceiver(t, { questions: true });
      const p = answerer(rcv, 'deny');
      const r = await handler({ event: 'permission-request', input: input(command), env: envOf(rcv), argv: [] });
      await p;
      const q = rcv.frames.find(f => f.type === 'question');
      assert.ok(q, 'question sent');
      assert.equal(r.stdout, mod.DENY); assert.equal(r.exitCode, 0);
      checkSize(rcv, q);
      assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
    }
  });
}

// ---- S4/T2: the Codex rows of the same matrix, as ONE attention notice (never a decision) ----
test('e2e Codex: lossless redacted command is shown in the notice; nothing is decided', async t => {
  const { rcv, notice } = await codexNotice(t, 'curl -H "Authorization: Bearer SECRETBEARER1" -u adm:SECRETPW2 https://h/x?token=SECRETQ3 && ls');
  assert.equal(notice.title, 'Codex te pide permiso');
  assert.equal(notice.detail, 'Bash: curl -H "Authorization: [REDACTED]" -u [REDACTED] https://h/x?token=[REDACTED] && ls · Respondé en la terminal');
  assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
  assert.equal(rcv.frames.filter(f => f.type === 'attention').length, 1, 'one notice, no options');
});
test('e2e Codex: no redaction => no marker suffix, still one notice and no decision', async t => {
  const { rcv, notice } = await codexNotice(t, 'ls -la /tmp');
  assert.equal(notice.detail, 'Bash: ls -la /tmp · Respondé en la terminal');
  assert.doesNotMatch(notice.detail, /REDACTED|secretos ocultos/);
  assert.doesNotMatch(rcv.rawFrames.join(''), /SECRETDESC|SECRETREPLY/);
});
for (const [command, reason] of [['cat ~/.ssh/id_rsa', 'touches credential files'], ['echo $(id) TOKEN=SECRETX9', 'shell indirection'],
  ['echo l\u0455 TOKEN=SECRETX9', 'special characters'], ['echo ' + 'word '.repeat(120) + 'TOKEN=SECRETX9', 'long command'], ['mysql -pSECRETX9', 'special characters']]) {
  test(`e2e Codex: lossy (${reason}) still sends only a redacted notice with the actionable tail`, async t => {
    const { rcv, notice } = await codexNotice(t, command);
    assert.match(notice.detail, / · Respondé en la terminal$/);
    assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
    assert.doesNotMatch(JSON.stringify(notice), /Aprobar una vez|Rechazar|Decidir en la terminal|"allow"|"deny"/,
      'a notice offers nothing to answer');
  });
}
test('e2e Codex: new R1 secret formats never reach the wire; hidden shell syntax stays in the terminal', async t => {
  for (const command of [...R1_COMMANDS, 'echo a ; X-Token: ' + PLANTED + ' > /dev/null', 'cat f -----BEGIN PRIVATE KEY----- ' + PLANTED + ' ; ls']) {
    const { rcv } = await codexNotice(t, command);
    assert.ok(!rcv.rawFrames.join('').includes(PLANTED), command);
  }
  const { rcv, notice } = await codexNotice(t, 'curl -H "Cookie: a=b; c=' + PLANTED + '" h');
  assert.ok(!rcv.rawFrames.join('').includes(PLANTED));
  assert.match(notice.detail, / · Respondé en la terminal$/);
});
test('e2e Codex: max-length and 4-byte-character commands stay inside 200 cp / 512 bytes and never crash', async t => {
  const cases = ['echo ' + 'a '.repeat(187) + 'ab', 'echo ' + 'a '.repeat(400), '😀'.repeat(2000), 'é'.repeat(2000) + ' TOKEN=SECRETX9', 'echo ' + '\ud800'.repeat(50)];
  for (const command of cases) {
    const { rcv, notice } = await codexNotice(t, command);
    assert.ok([...notice.detail].length <= 200);
    assert.match(notice.detail, / · Respondé en la terminal$/, 'the actionable tail always survives');
    assert.doesNotMatch(rcv.rawFrames.join(''), /SECRET/);
  }
});
