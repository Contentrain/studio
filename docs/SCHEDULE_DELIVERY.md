# Scheduled delivery recovery

Migration `025_schedule_delivery_lease.sql` changes a schedule claim into a
15-minute lease. `fired_at` is written only after the configured CDN build and
deploy hook have succeeded. A failed delivery is eligible again after one minute;
a crashed worker's lease expires automatically. A resave invalidates old claims.

Apply the shared migration before running the updated scheduler. Restart old
application instances together: old scheduler code does not acknowledge leases.
Existing fired rows are retained; this migration cannot infer which historic
external deliveries succeeded.

Deploy hooks are **at-least-once**. A crash after the host accepts a hook but before
the database acknowledgement can trigger another build. Hook acceptance is not a
claim that the host finished deploying. Host completion polling and delivery
receipts remain separate work.

No in-memory debounce timer is used for scheduled hooks. Missing configured CDN
providers, busy CDN builds, reported build errors and rejected hooks all leave work
retryable. A late worker cannot acknowledge a replacement claim or resaved entry.

Verification: scheduling provider contract tests on disposable PostgreSQL 16;
worker tests for success, hook rejection, unavailable provider, busy build and
reported build failure. Production provider acceptance is still required.
