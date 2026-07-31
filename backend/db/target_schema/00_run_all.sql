-- Target 9-table schema — run in order. Each file is idempotent.
\i 01_types.sql
\i 02_tables.sql
\i 03_indexes.sql
\i 04_triggers.sql
