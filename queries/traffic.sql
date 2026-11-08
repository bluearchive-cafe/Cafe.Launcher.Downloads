-- Last 30 UTC calendar days: per-asset requests and declared response bytes.
SELECT tag, file, SUM(requests) AS requests,
       SUM(response_bytes) AS declared_response_bytes
FROM traffic_daily
WHERE day >= date('now', '-29 days') AND route = 'download'
GROUP BY tag, file
ORDER BY declared_response_bytes DESC;

-- Error and rate-limit counts, including rejected requests before any bucket read.
SELECT route, status, SUM(requests) AS requests
FROM traffic_daily
WHERE day >= date('now', '-29 days')
GROUP BY route, status
ORDER BY requests DESC;

-- Cache versus R2 requests (not completed-download counts).
SELECT source, SUM(requests) AS requests
FROM traffic_daily
WHERE day >= date('now', '-29 days') AND route = 'download' AND status = 200
GROUP BY source;
