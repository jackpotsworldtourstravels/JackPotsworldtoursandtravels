# Phase 1 — Database Queries Reference

## Verify Current Database

```sql
SELECT current_database();
```

## Verify No Tables Exist

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema='public';
```

## List All Tables

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema='public';
```

## Count Tables

```sql
SELECT COUNT(*)
FROM information_schema.tables
WHERE table_schema='public';
```

## View Users

```sql
SELECT * FROM users;
```

## View Merchants

```sql
SELECT * FROM merchants;
```

## View Service Requests

```sql
SELECT * FROM service_requests;
```

## View Payments

```sql
SELECT * FROM payments;
```

## View Passenger Data

```sql
SELECT * FROM passenger_data;
```

## View Communication Settings

```sql
SELECT * FROM communication_settings;
```

## View Message Logs

```sql
SELECT * FROM msg_logs;
```

## View System Logs

```sql
SELECT * FROM system_logs;
```

## View Audit Logs

```sql
SELECT * FROM audit_logs;
```

## Verify Views

```sql
SELECT table_name
FROM information_schema.views
WHERE table_schema='public';
```

## Update Payment

```sql
UPDATE payments
SET
    amount = 30000.00,
    payment_method = 'UPI',
    payment_status = 'SUCCESS',
    transaction_id = 'TXN123456789',
    payment_date = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE payment_id = 1;
```

## Update Booking Status

```sql
UPDATE service_requests
SET status='APPROVED'
WHERE request_id=1;
```

## Update Merchant

```sql
UPDATE merchants
SET city='Bengaluru'
WHERE merchant_id=1;
```
