#!/usr/bin/env bash
# Khởi chạy Dashboard Quota Antigravity Tiếng Việt 100%

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=================================================="
echo "  🚀 TRÌNH GIÁM SÁT & QUẢN LÝ QUOTA ANTIGRAVITY"
echo "  🌐 Giao diện: 100% TIẾNG VIỆT"
echo "=================================================="

# 1. Đóng app tiếng Trung nếu đang mở
if pgrep -fl "cpa-gui" > /dev/null; then
    echo "ℹ️ Đang đóng ứng dụng giao diện tiếng Trung..."
    killall cpa-gui 2>/dev/null
    sleep 1
fi

# 2. Đảm bảo Core Proxy chạy độc lập ở nền
if ! pgrep -fl "cli-proxy-api" > /dev/null; then
    echo "🔄 Đang khởi động Core Proxy Server (8317)..."
    CORE_BIN="$HOME/Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api"
    CORE_CONF="$HOME/Library/Application Support/com.cpa.gui/cpa-core/config.yaml"
    if [ -f "$CORE_BIN" ]; then
        nohup "$CORE_BIN" -config "$CORE_CONF" > /dev/null 2>&1 &
        sleep 2
    fi
fi

# 3. Khởi động Web Dashboard Server (Node.js) nếu chưa chạy
if ! lsof -i :5200 > /dev/null 2>&1; then
    echo "🔄 Đang khởi động Web Dashboard Tiếng Việt tại http://localhost:5200..."
    nohup node server.mjs > /dev/null 2>&1 &
    sleep 1.5
fi

# 4. Mở trình duyệt web
echo "✅ Đang mở Dashboard trên trình duyệt..."
open "http://localhost:5200"

echo ""
echo "👉 Dashboard Tiếng Việt đã sẵn sàng tại: http://localhost:5200"
echo "   Endpoint API Proxy: http://127.0.0.1:8317/v1"
echo "=================================================="
