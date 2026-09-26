#!/usr/bin/env bash
# Tests for scripts/opaque-backup and scripts/opaque-verify-backup.
# Requires bash, tar, gpg. Run: bash scripts/test-opaque-backup.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$HERE/opaque-backup"
VERIFY="$HERE/opaque-verify-backup"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GNUPGHOME="$T/gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME" || true

pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

REPO="$T/repo"
mkdir -p "$REPO/asp/data/state" "$REPO/publisher/data/inbox" "$T/relayer"
echo '{"cursor":1}' > "$REPO/asp/data/state/pool.json"
echo '{"leaf":"0x01"}' > "$REPO/publisher/data/inbox/a.json"
echo '{"bids":[]}' > "$T/relayer/hub.json"
echo "test-passphrase" > "$T/pass"
chmod 600 "$T/pass"

export OPAQUE_BACKUP_DIR="$T/backups"
export OPAQUE_REPO_ROOT="$REPO"
export OPAQUE_BACKUP_PASSPHRASE_FILE="$T/pass"
unset RELAYER_DATA_DIR ASP_DATA_DIR PUBLISHER_DATA_DIR OPAQUE_BACKUP_RETENTION_DAYS

# dry-run writes nothing
out=$("$BACKUP" --dry-run)
[[ ! -e "$T/backups" ]] || fail "dry-run created backup dir"
grep -q "would back up asp" <<<"$out" || fail "dry-run did not report asp"
ok "dry-run makes no changes"

# real run: asp + publisher backed up, relayer skipped (no RELAYER_DATA_DIR)
out=$("$BACKUP")
[[ $(ls "$T/backups"/asp-*.tar.gz.gpg | wc -l) -eq 1 ]] || fail "asp backup missing"
[[ $(ls "$T/backups"/publisher-*.tar.gz.gpg | wc -l) -eq 1 ]] || fail "publisher backup missing"
grep -q "SKIP: relayer" <<<"$out" || fail "relayer should be skipped when RELAYER_DATA_DIR unset"
ok "backs up asp and publisher, skips unconfigured relayer"

# archive is encrypted, and round-trips with the passphrase
f=$(ls "$T/backups"/publisher-*.tar.gz.gpg)
if tar -tzf "$f" >/dev/null 2>&1; then fail "backup is not encrypted"; fi
gpg --batch --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$f" 2>/dev/null \
  | tar -xzO data/inbox/a.json | grep -q 0x01 || fail "restore round-trip failed"
ok "backup is encrypted and restores"

# verify passes, then relayer is included when configured
"$VERIFY" | grep -q "all services OK" || fail "verify should pass"
sleep 1 # distinct timestamp for the next backup set
export RELAYER_DATA_DIR="$T/relayer"
"$BACKUP" > /dev/null
"$VERIFY" | grep -q "OK: relayer" || fail "verify should cover relayer"
ok "verify passes for all configured services"

# verify detects corruption
latest=$(ls "$T/backups"/asp-*.tar.gz.gpg | sort | tail -1)
head -c 20 /dev/urandom > "$latest"
if "$VERIFY" > /dev/null 2>&1; then fail "verify should fail on corrupt backup"; fi
ok "verify fails on corrupt backup"

# verify detects missing backups
rm -f "$T/backups"/publisher-*
if "$VERIFY" > /dev/null 2>&1; then fail "verify should fail when publisher backup missing"; fi
ok "verify fails on missing backup"

# per-service pruning: old asp pruned, old publisher (90d) kept
touch -d '40 days ago' "$T/backups/asp-19990101T000000Z.tar.gz.gpg"
touch -d '40 days ago' "$T/backups/publisher-19990101T000000Z.tar.gz.gpg"
"$BACKUP" > /dev/null
[[ ! -e "$T/backups/asp-19990101T000000Z.tar.gz.gpg" ]] || fail "old asp backup not pruned"
[[ -e "$T/backups/publisher-19990101T000000Z.tar.gz.gpg" ]] || fail "publisher pruned before 90 days"
ok "retention is per service"

# missing passphrase fails loudly
if OPAQUE_BACKUP_PASSPHRASE_FILE="$T/nope" "$BACKUP" > /dev/null 2>&1; then fail "should fail without passphrase"; fi
ok "missing passphrase file is an error"

echo "$pass tests passed"
