# Migration Rollbacks

Files in this directory are **manual rollback scripts** for the matching forward migrations in the parent directory. They are NOT auto-applied by the Migrator (`src/storage/migrator.ts`) — `readdirSync` is non-recursive, so this subdirectory is invisible to the auto-apply scan.

## How to use

To roll back migration `NNN` manually:

```bash
psql "$DATABASE_URL" -f src/storage/migrations/rollbacks/NNN-rollback.sql
```

The rollback drops columns, indexes, and constraints added by the corresponding forward migration. Make a database backup before running a rollback in any environment with real data.

## Naming convention

Each rollback file is named `NNN-rollback.sql` where `NNN` matches the forward migration's version prefix.
