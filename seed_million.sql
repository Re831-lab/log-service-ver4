DO $$
DECLARE
  d date;
BEGIN
  FOR d IN SELECT generate_series(CURRENT_DATE - INTERVAL '35 days', CURRENT_DATE + INTERVAL '1 day', INTERVAL '1 day')::date
  LOOP
    PERFORM create_logs_partition(d);
  END LOOP;
END $$;

WITH seeded AS (
  SELECT
    gs AS row_num,
    (CURRENT_DATE - (floor(random() * 30))::int) AS day_offset,
    (random() * 86400)::int AS seconds_into_day
  FROM generate_series(1, 1000000) AS gs
)
INSERT INTO logs (timestamp, level, service, message, attributes)
SELECT
  day_offset + (seconds_into_day || ' seconds')::interval,
  (ARRAY['debug','info','warn','error'])[floor(random()*4+1)],
  (ARRAY['checkout','auth','payments','inventory','shipping'])[floor(random()*5+1)],
  'seeded event ' || row_num,
  jsonb_build_object(
    'user_id', (floor(random()*10000))::text,
    'region', 'eu-west',
    'retries', floor(random()*5)
  )
FROM seeded;

SELECT tableoid::regclass AS partition_name, count(*)
FROM logs
GROUP BY tableoid
ORDER BY partition_name;
