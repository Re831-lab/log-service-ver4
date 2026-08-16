CREATE OR REPLACE FUNCTION create_logs_partition(target_date date)
RETURNS void AS $$
DECLARE
  partition_name text;
  start_range timestamptz;
  end_range timestamptz;
BEGIN
  partition_name := 'logs_' || to_char(target_date, 'YYYY_MM_DD');
  start_range := target_date::timestamptz;
  end_range := (target_date + interval '1 day')::timestamptz;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_range, end_range
    );
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION drop_old_log_partitions(retention_days integer)
RETURNS TABLE(dropped_partition text) AS $$
DECLARE
  part record;
  cutoff_date date;
BEGIN
  cutoff_date := (CURRENT_DATE - retention_days * interval '1 day')::date;

  FOR part IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = 'logs'
      AND c.relname ~ '^logs_\d{4}_\d{2}_\d{2}$'
      AND to_date(substring(c.relname from 'logs_(\d{4}_\d{2}_\d{2})$'), 'YYYY_MM_DD') < cutoff_date
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I', part.relname);
    dropped_partition := part.relname;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

SELECT create_logs_partition(CURRENT_DATE - 1);
SELECT create_logs_partition(CURRENT_DATE);
SELECT create_logs_partition(CURRENT_DATE + 1);