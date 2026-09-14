<?php
/* ------------------------------------------------------------------ *
 *  Rooms: the "FIND A RACE" lobby. A host registers its room with a
 *  heartbeat (POST every few seconds); GET returns the fresh rooms.
 *  Storage: one JSON file, lazy-pruned (entries idle > 20 s vanish).
 * ------------------------------------------------------------------ */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$dir = getenv('MK_DATA_DIR') ?: (getenv('TMPDIR') ?: '/tmp') . '/microkarts-data';
if (!is_dir($dir)) @mkdir($dir, 0777, true);
$f = $dir . '/rooms.json';
$now = time();

$load = function () use ($f, $now) {
    $r = [];
    if (is_file($f)) {
        $d = @json_decode((string)@file_get_contents($f), true);
        if (is_array($d)) foreach ($d as $code => $e)
            if (is_array($e) && $now - (int)$e['ts'] < 20) $r[$code] = $e;
    }
    return $r;
};
$save = function ($r) use ($f) {
    if ($fh = @fopen($f, 'c')) { flock($fh, LOCK_EX); ftruncate($fh, 0);
        fwrite($fh, json_encode($r)); flock($fh, LOCK_UN); fclose($fh); }
};

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $b = json_decode((string)file_get_contents('php://input'), true);
    $code = strtoupper(trim($b['code'] ?? ''));
    if (!preg_match('/^[A-Z2-9]{4,8}$/', $code)) { echo '{"error":"bad code"}'; exit; }
    $r = $load();
    $r[$code] = ['name' => substr(trim((string)($b['name'] ?? '')), 0, 16) ?: 'HOST',
                 'track' => max(0, min(31, (int)($b['track'] ?? 0))), 'ts' => $now];
    $save($r);
    echo '{"ok":true}';
    exit;
}

$r = $load();
$save($r); // the read also prunes
$rooms = array_map(function ($c, $e) {
    return ['code' => $c, 'name' => $e['name'], 'track' => $e['track']];
}, array_keys($r), array_values($r));
echo json_encode(['rooms' => $rooms]);
