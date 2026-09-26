# Scheduled State Backups for Protocol Services

The ASP indexer, reputation publisher, and relayer each maintain local state that is
not recoverable from on-chain data alone. This guide covers scheduled encrypted backups,
restore verification, and retention policy for each service.

## What needs backing up

| Service | State directory | Why it cannot be rebuilt from chain |
|:--|:--|:--|
| ASP | `asp/data/` | Approved-set membership decisions and incremental event cursor |
| Publisher | `publisher/data/` | Holder-submitted leaf commitments (private, never on-chain) |
| Relayer hub (optional) | the directory set by `RELAYER_DATA_DIR` (contains `hub.json`); no default | Gossip-hub bids, outcomes, and operator stats. Only the hub persists, and only when `RELAYER_DATA_DIR` is set; a relayer node persists nothing, so there is nothing to back up when the variable is unset |

The publisher's inbox is the most critical: leaf commitments are submitted off-chain by
holders and cannot be reconstructed from public events. Losing them means affected
holders must resubmit their leaves.

## Backup script

The script ships in this repo as [`scripts/opaque-backup`](../scripts/opaque-backup)
(tests: [`scripts/test-opaque-backup.sh`](../scripts/test-opaque-backup.sh)). Install it:

```bash
sudo install -m 0755 scripts/opaque-backup /usr/local/bin/opaque-backup
sudo install -m 0755 scripts/opaque-verify-backup /usr/local/bin/opaque-verify-backup
```

Preview what it would do without writing anything with `opaque-backup --dry-run`.
It reads `ASP_DATA_DIR` / `PUBLISHER_DATA_DIR` (the same variables the services use;
defaults `<repo>/asp/data` and `<repo>/publisher/data`) and `RELAYER_DATA_DIR`,
skips anything that is not configured or does not exist, applies the per-service
retention from the table below (`OPAQUE_BACKUP_RETENTION_DAYS` overrides all), and
writes each archive atomically.


Generate and store the passphrase once:

```bash
openssl rand -base64 32 | sudo tee /etc/opaque/backup-passphrase > /dev/null
sudo chmod 600 /etc/opaque/backup-passphrase
```

## Scheduling with cron

Run backups every 6 hours:

```bash
sudo crontab -e
```

```cron
0 */6 * * * /usr/local/bin/opaque-backup >> /var/log/opaque-backup.log 2>&1
```

## Scheduling with systemd timer (alternative)

```ini
# /etc/systemd/system/opaque-backup.service
[Unit]
Description=Opaque protocol service state backup

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/bin/opaque-backup
StandardOutput=journal
StandardError=journal
```

```ini
# /etc/systemd/system/opaque-backup.timer
[Unit]
Description=Run Opaque backup every 6 hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opaque-backup.timer
sudo systemctl list-timers opaque-backup.timer
```

## Restore procedure

```bash
# List available backups
ls -lh /var/backups/opaque/

# Decrypt and extract a specific backup
gpg --batch --passphrase-file /etc/opaque/backup-passphrase \
    --decrypt /var/backups/opaque/publisher-20260101T120000Z.tar.gz.gpg \
  | tar -xzf - -C /tmp/opaque-restore/

# Inspect the restored tree
ls -la /tmp/opaque-restore/data/

# Stop the service before restoring live state
sudo systemctl stop opaque-publisher

# Replace live state
rsync -a --delete /tmp/opaque-restore/data/ /srv/opaque/stellar/publisher/data/

# Restart
sudo systemctl start opaque-publisher
```

## Automated restore verification

The verifier ships as [`scripts/opaque-verify-backup`](../scripts/opaque-verify-backup)
(installed above). It decrypts the newest backup of each service, extracts it into a
temp directory, requires it to be non-empty, and exits non-zero on any failure (the
relayer is checked only when `RELAYER_DATA_DIR` is set). Schedule it weekly.


Schedule weekly:

```cron
0 3 * * 0 /usr/local/bin/opaque-verify-backup >> /var/log/opaque-backup.log 2>&1
```

## Retention policy

| Service | Retention | Rationale |
|:--|:--|:--|
| ASP | 30 days | Event cursor can be rebuilt from chain if needed; 30 days covers any incident response window |
| Publisher | 90 days | Leaf commitments are irreplaceable; longer retention protects against silent data loss |
| Relayer | 30 days | Job history is informational; operator key and registration are the critical items |

The script applies these per-service defaults automatically. Set
`OPAQUE_BACKUP_RETENTION_DAYS` to override the retention for all services at once.

## Off-site replication

For production, replicate backups to a second location. Example using `rclone` to S3:

```bash
# Configure rclone once
rclone config

# Run after opaque-backup, e.g. from a wrapper script or ExecStartPost
rclone sync "$BACKUP_ROOT" s3:your-bucket/opaque-backups/ \
  --s3-sse AES256 \
  --log-level INFO
```

Ensure the S3 bucket has versioning enabled and a lifecycle rule that matches the
retention policy above.
