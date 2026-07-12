#!/usr/bin/env bash
# ADHERE+ pre-deploy check. Run this BEFORE every push. It takes under a second.
#
#   bash scripts/check.sh
#
# WHY THE TRUNCATION GUARD EXISTS
# The repo lives in OneDrive with Files-On-Demand. When a file is a cloud placeholder, a Linux
# reader can see only a partially-materialised PREFIX of it — app.js has been seen as 1,102 lines
# when it is really 3,393. Linting a truncated file gives a MEANINGLESS pass (or a meaningless
# failure at the cut point). So we check the file is whole before we check it is valid.
# If this guard trips: in File Explorer, right-click the repo folder ->
# "Always keep on this device", wait for the green tick, and re-run.
#
# WHY WE ALSO BUILD THE SQL
# A PHP lint proves the STRING is well-formed. It says nothing about whether the string is valid
# SQL. On 12 July 2026 an unbalanced paren inside a concatenated EXISTS(...) clause passed the PHP
# lint, threw a SQL syntax error on every /api/episodes call, and made the whole app look as
# though it had lost every patient. Lint the PHP *and* balance the SQL.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
say(){ printf '%s\n' "$*"; }
ok(){  printf '  ok    %s\n' "$*"; }
bad(){ printf '  FAIL  %s\n' "$*"; fail=1; }

say "== 1. files are whole (not OneDrive placeholders) =="
check_whole(){  # path  min_lines  must_end_with
  local f="$1" min="$2" tail_re="$3"
  [ -f "$f" ] || { bad "$f missing"; return; }
  local n; n=$(wc -l < "$f")
  if [ "$n" -lt "$min" ]; then bad "$f is only $n lines (expected >= $min) — TRUNCATED placeholder, do not trust any lint below"; return; fi
  if ! tail -c 400 "$f" | grep -qE "$tail_re"; then bad "$f does not end as expected — likely truncated"; return; fi
  ok "$f ($n lines)"
}
check_whole public/app.js          2500 'boot\(\);'
check_whole public/api/index.php    600 'Throwable|err\('
check_whole public/service-worker.js  10 '\}\);'
check_whole public/index.html         10 '</html>'

if [ "$fail" -ne 0 ]; then
  say ""
  say "STOP. A file looks truncated. Right-click the repo folder in File Explorer ->"
  say "'Always keep on this device', wait for the green tick, then re-run."
  exit 1
fi

say ""
say "== 2. syntax =="
if node --check public/app.js 2>/dev/null; then ok "app.js parses"; else bad "app.js SYNTAX ERROR"; node --check public/app.js; fi

if [ -d node_modules/php-parser ] || [ -d scripts/node_modules/php-parser ]; then
  node -e "
    const fs=require('fs'); const engine=require('php-parser');
    const p=new engine({parser:{version:804,suppressErrors:false}});
    const a=p.parseCode(fs.readFileSync('public/api/index.php','utf8'));
    const e=(a.errors||[]);
    if(e.length){ e.forEach(x=>console.log('  FAIL  index.php line '+x.line+': '+x.message)); process.exit(1); }
    console.log('  ok    index.php parses');
  " || fail=1
else
  say "  --    php-parser not installed (npm i php-parser) — skipping PHP lint"
fi

say ""
say "== 3. generated SQL is paren-balanced =="
# Concatenated SQL is the trap: each literal can balance while the CONCATENATION does not.
python3 - <<'PY' || fail=1
import re,sys
src=open('public/api/index.php').read()
bad=[]
# join adjacent PHP string concatenations on the same statement, crudely, then balance-check
for m in re.finditer(r'\$(?:hr|sql|rc|sc|an|mf)\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\.?\s*|\$\w+\s*\(?[^;]*?\)?\s*\.?\s*)+);', src, re.S):
    frag=m.group(1)
    lits=''.join(re.findall(r'"((?:[^"\\]|\\.)*)"', frag))
    d=0; okk=True
    for ch in lits:
        if ch=='(': d+=1
        elif ch==')':
            d-=1
            if d<0: okk=False; break
    if not okk or d!=0:
        bad.append((src[:m.start()].count('\n')+1, d))
if bad:
    for line,d in bad: print(f"  FAIL  concatenated SQL near line {line}: paren depth ends at {d} (should be 0)")
    sys.exit(1)
print("  ok    concatenated SQL balances")
PY

say ""
if [ "$fail" -eq 0 ]; then say "ALL CHECKS PASSED — safe to push."; else say "CHECKS FAILED — do not push."; fi
exit $fail
