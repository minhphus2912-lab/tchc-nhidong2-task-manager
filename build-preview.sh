#!/usr/bin/env bash
# Dựng bản preview/index.html từ CHÍNH Styles.html + JsClient.html của Apps Script,
# đảm bảo CSS/JS preview luôn ĐỒNG NHẤT với bản deploy thật.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/apps-script"
OUT="$ROOT/preview/index.html"

{
  cat <<'HTML'
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quản lý công việc — Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2 (Bản xem trước)</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
HTML
  cat "$SRC/Styles.html"
  cat <<'HTML'
</head>
<body>
  <div class="bg-orb"></div>
  <div class="loading-screen"><span class="spin"></span> Đang tải hệ thống...</div>
HTML
  cat "$SRC/JsClient.html"
  cat <<'HTML'
</body>
</html>
HTML
} > "$OUT"

echo "Built preview -> $OUT ($(wc -l < "$OUT") dòng)"
