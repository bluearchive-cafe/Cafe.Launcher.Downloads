export interface RequestMetric {
  route: string;
  tag: string;
  file: string;
  method: string;
  source: string;
  status: number;
  responseBytes: number;
  durationMs: number;
}

// Atomic upsert avoids the lost updates of read/modify/write counters. No raw
// IP addresses, headers, query strings, user identifiers or per-user rows.
export async function recordRequest(db: D1Database, metric: RequestMetric): Promise<void> {
  await db.prepare(`
    INSERT INTO traffic_daily (day, route, tag, file, method, source, status, requests, response_bytes, handler_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT (day, route, tag, file, method, source, status) DO UPDATE SET
      requests = requests + 1,
      response_bytes = response_bytes + excluded.response_bytes,
      handler_ms = handler_ms + excluded.handler_ms
  `).bind(
    new Date().toISOString().slice(0, 10), metric.route, metric.tag, metric.file,
    metric.method, metric.source, metric.status, metric.responseBytes, metric.durationMs,
  ).run();
}

export async function readStatistics(db: D1Database): Promise<unknown> {
  const [summary, rows] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(response_bytes), 0) AS declaredResponseBytes,
      COALESCE(SUM(CASE WHEN status >= 400 THEN requests ELSE 0 END), 0) AS rejectedOrFailedRequests
      FROM traffic_daily WHERE day >= date('now', '-29 days')`),
    db.prepare(`SELECT day, route, tag, file, method, source, status, requests,
      response_bytes AS declaredResponseBytes, handler_ms AS handlerMs
      FROM traffic_daily WHERE day >= date('now', '-29 days')
      ORDER BY day DESC, requests DESC LIMIT 500`),
  ]);
  return {
    window: '30 UTC calendar days including today',
    byteMetric: 'Declared response bytes for GET 200/206; not confirmed delivered bytes or completed downloads',
    summary: summary.results[0], rows: rows.results, rowLimit: 500,
  };
}
