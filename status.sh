#!/usr/bin/env bash
# Script kiểm tra trạng thái Hệ Thống Quota Antigravity

echo "=================================================="
echo "  🔍 KIỂM TRA TRẠNG THÁI HỆ THỐNG QUOTA ANTIGRAVITY"
echo "=================================================="

echo ""
echo "[1] TIẾN TRÌNH HOẠT ĐỘNG:"
if pgrep -fl "cli-proxy-api" > /dev/null; then
    echo "  ✅ Core Proxy Server (Port 8317): ĐANG CHẠY"
else
    echo "  ⚠️ Core Proxy Server (Port 8317): CHƯA CHẠY"
fi

if lsof -iTCP:5200 -sTCP:LISTEN -P -n > /dev/null 2>&1; then
    echo "  ✅ Web Dashboard Tiếng Việt (Port 5200): ĐANG CHẠY"
else
    echo "  ⚠️ Web Dashboard Tiếng Việt (Port 5200): CHƯA CHẠY"
fi

echo ""
echo "[2] KIỂM TRA CỔNG MẠNG NỘI BỘ (127.0.0.1):"
PROXY_PING=$(curl -s http://127.0.0.1:8317/ 2>/dev/null)
if [[ -n "$PROXY_PING" ]]; then
    echo "  ✅ Proxy API (http://127.0.0.1:8317/v1): SẴN SÀNG"
else
    echo "  ❌ Proxy API: KHÔNG PHẢN HỒI"
fi

DASH_PING=$(curl -s -I http://127.0.0.1:5200/ 2>/dev/null | head -n 1)
if [[ "$DASH_PING" =~ "200" ]]; then
    echo "  ✅ Web Dashboard (http://localhost:5200): SẴN SÀNG"
else
    echo "  ❌ Web Dashboard: KHÔNG PHẢN HỒI"
fi

echo ""
echo "[3] TÀI KHOẢN ANTIGRAVITY ĐÃ KẾT NỐI:"
OAUTH_DIR="$HOME/Library/Application Support/com.cpa.gui/oauth"
if [ -d "$OAUTH_DIR" ]; then
    ACCOUNTS=$(ls -1 "$OAUTH_DIR" 2>/dev/null | grep -E '^antigravity-.*\.json$')
    COUNT=$(echo "$ACCOUNTS" | grep -c "antigravity" || echo 0)
    echo "  👥 Tổng số tài khoản trong Pool: $COUNT"
    if [ "$COUNT" -gt 0 ]; then
        for acc in $ACCOUNTS; do
            CLEAN_NAME=$(echo "$acc" | sed 's/antigravity-//g' | sed 's/\.json//g')
            echo "     • $CLEAN_NAME"
        done
    fi
else
    echo "  ⚠️ Chưa tìm thấy thư mục OAuth."
fi

echo ""
echo "👉 Mở Dashboard: Nhấp đúp vào icon 'Quota Antigravity' trên Desktop"
echo "   hoặc chạy: open 'http://localhost:5200'"
echo "=================================================="
