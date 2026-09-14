<?php
/* ------------------------------------------------------------------ *
 *  Relay: per-room message queue over long-poll.
 *
 *  The game's binary frames (u8 protocol, see src/net.js) ride in the
 *  POST body raw; they come back base64 in the long-poll batch. The
 *  server is deliberately dumb: it does NOT decode frames — the client
 *  filters by frame type byte + `from` identity.
 *
 *  Contract (also implemented by the dev mock in ai-sim/relay-check.mjs):
 *    GET  /api/relay.php?room=CODE&after=SEQ   (long-poll ≤20 s)
 *         -> {"msgs":[{"seq":N,"from":"HOST|P2","data":"<b64>"}...]}
 *    POST /api/relay.php?room=CODE&who=HOST|P2 (raw body, <8 KB)
 *         -> {"ok":true,"seq":N}
 *    GET  /api/relay.php (no room)  -> {"rooms": false}
 * ------------------------------------------------------------------ */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$dir = getenv('MK_DATA_DIR') ?: (getenv('TMPDIR') ?: '/tmp') . '/microkarts-data';
if (!is_dir($dir)) @mkdir($dir, 0777, true);
$room = strtoupper(trim($_GET['room'] ?? ''));
if (!preg_match('/^[A-Z2-9]{4,8}$/', $room)) { echo '{"error":"bad room"}'; exit; }
$rf = $dir . '/room-' . $room . '.jsonl';
$now = time();

// lazy prune: a room file idle > 30 s is reset (clients re-register)
if (is_file($rf) && $now - filemtime($rf) > 30) @unlink($rf);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $who = strtoupper($_GET['who'] ?? '');
    if ($who !== 'HOST' && $who !== 'P2') { echo '{"error":"bad who"}'; exit; }
    $body = file_get_contents('php://input');
    if (strlen($body) > 8192) { echo '{"error":"too big"}'; exit; }
    $seq = 0;
    if ($fh = @fopen($rf, 'c+')) {
        flock($fh, LOCK_EX);
        // count existing entries (cheap: small files, ≤ a few KB)
        $n = 0;
        while (!feof($fh)) { if (fgets($fh) !== false) $n++; }
        $seq = $n + 1;
        $entry = json_encode(['seq' => $seq, 'from' => $who,
            'data' => base64_encode($body), 'ts' => $now]);
        fseek($fh, 0, SEEK_END);
        fwrite($fh, $entry . "\n");
        flock($fh, LOCK_UN);
        fclose($fh);
    }
    echo '{"ok":true,"seq":' . $seq . '}';
    exit;
}

/* ---- long-poll: new messages, or an empty batch after 20 s ----
 * Detection is by file SIZE (mtime has 1 s granularity — an append inside
 * the same second would be invisible). The client dedupes by seq, so
 * re-sending already-seen lines is harmless; the only filter is seq. */
$after = (int)($_GET['after'] ?? 0);
set_time_limit(30);
$deadline = microtime(true) + 20.0;
$lastSize = 0;
$read = false;
while (microtime(true) < $deadline) {
    clearstatcache();
    if (is_file($rf)) {
        $size = filesize($rf);
        if (!$read || $size !== $lastSize) {
            $read = true;
            $lastSize = $size;
            $out = [];
            if ($fh = @fopen($rf, 'r')) {
                while (!feof($fh)) {
                    $line = fgets($fh);
                    if ($line === false) break;
                    $line = trim($line);
                    if ($line === '') continue;
                    $e = json_decode($line, true);
                    if ($e && ($e['seq'] ?? 0) > $after) $out[] = $e;
                }
                fclose($fh);
            }
            if ($out) {
                echo '{"msgs":' . json_encode($out) . '}';
                exit;
            }
        }
    }
    usleep(200000);
}
echo '{"msgs":[]}';
