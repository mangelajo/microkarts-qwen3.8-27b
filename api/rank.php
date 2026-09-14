<?php
/* ------------------------------------------------------------------ *
 *  Rank: global top-5 per track. POST a lap (name, track, ms);
 *  GET the board. Rate-limited: one submission per 10 s per
 *  name+track (lazy-pruned seen map). Storage: one JSON file.
 * ------------------------------------------------------------------ */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$dir = getenv('MK_DATA_DIR') ?: (getenv('TMPDIR') ?: '/tmp') . '/microkarts-data';
if (!is_dir($dir)) @mkdir($dir, 0777, true);
clearstatcache();
$rf = $dir . '/rank.json';
$sf = $dir . '/rank-seen.json';
$now = time();

$load = function ($f, $ttl = null) use ($now) {
    $d = [];
    if (is_file($f)) {
        $d = json_decode((string)@file_get_contents($f), true);
        if (!is_array($d)) $d = [];
        if ($ttl !== null) foreach ($d as $k => $v)
            if ($now - (int)$v > $ttl) unset($d[$k]);
    }
    return $d;
};
$save = function ($d, $f) {
    if ($fh = @fopen($f, 'c')) { flock($fh, LOCK_EX); ftruncate($fh, 0);
        fwrite($fh, json_encode($d)); flock($fh, LOCK_UN); fclose($fh); }
};

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $b = json_decode((string)file_get_contents('php://input'), true);
    $name = substr(trim((string)($b['name'] ?? '')), 0, 16);
    $track = (int)($b['track'] ?? -1);
    $ms = (int)($b['ms'] ?? 0);
    if ($name === '' || $track < 0 || $track > 31 || $ms <= 0 || $ms > 3600000) {
        echo '{"error":"bad input"}'; exit;
    }
    $seen = $load($sf, 10);
    $key = $name . '|' . $track;
    if (isset($seen[$key])) { echo '{"error":"rate limited"}'; exit; }
    $seen[$key] = $now;
    $save($seen, $sf);
    $board = $load($rf);
    $list = is_array($board[$track] ?? null) ? $board[$track] : [];
    $list[] = ['name' => $name, 'ms' => $ms];
    usort($list, fn($a, $b2) => $a['ms'] <=> $b2['ms']);
    $board[$track] = array_slice($list, 0, 5);
    $save($board, $rf);
    echo '{"ok":true}';
    exit;
}

$track = (int)($_GET['track'] ?? -1);
clearstatcache();
$board = $load($rf);
$entries = is_array($board[$track] ?? null) ? $board[$track] : [];
echo json_encode(['track' => $track, 'top' => $entries]);
