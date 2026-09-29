#!/usr/bin/env bash
# Khởi chạy Dashboard Quota Antigravity Tiếng Việt 100%

# Đảm bảo PATH đầy đủ cho môi trường GUI macOS (Finder, Spotlight, AppleScript)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$PATH"

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
CORE_BIN="$HOME/Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api"
CORE_CONF="$HOME/Library/Application Support/com.cpa.gui/cpa-core/config.yaml"
if ! pgrep -fl "cli-proxy-api" > /dev/null; then
    echo "🔄 Đang khởi động Core Proxy Server (8317)..."
    if [ -f "$CORE_BIN" ]; then
        chmod +x "$CORE_BIN" 2>/dev/null
        CORE_DIR="$(dirname "$CORE_BIN")"
        (cd "$CORE_DIR" && nohup "$CORE_BIN" -config "$CORE_CONF" > "$DIR/proxy-core.log" 2>&1 &)
        for i in {1..15}; do
            if curl -s http://127.0.0.1:8317/ > /dev/null 2>&1; then
                break
            fi
            sleep 0.2
        done
    fi
fi

# 3. Tìm đường dẫn Node.js khả dụng
NODE_BIN=""
if command -v node > /dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
    NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
    NODE_BIN="/usr/local/bin/node"
else
    for p in "$HOME/.nvm/versions/node/"*"/bin/node"; do
        if [ -x "$p" ]; then
            NODE_BIN="$p"
            break
        fi
    done
fi

if [ -z "$NODE_BIN" ]; then
    echo "❌ Lỗi: Không tìm thấy Node.js trên máy!"
    osascript -e 'display alert "Lỗi Quota Antigravity" message "Không tìm thấy Node.js trên máy Mac. Vui lòng cài đặt Node.js để tiếp tục."' 2>/dev/null &
    exit 1
fi

# 4. Khởi động Web Dashboard Server (Node.js) nếu chưa chạy
if ! lsof -iTCP:5200 -sTCP:LISTEN -P -n > /dev/null 2>&1; then
    echo "🔄 Đang khởi động Web Dashboard Tiếng Việt tại http://localhost:5200..."
    nohup "$NODE_BIN" server.mjs > "$DIR/server.log" 2>&1 &
    
    # Chờ server sẵn sàng lắng nghe trước khi mở trình duyệt
    for i in {1..20}; do
        if curl -s -I http://127.0.0.1:5200/ > /dev/null 2>&1; then
            break
        fi
        sleep 0.2
    done
fi

# 5. Mở trình duyệt web
echo "✅ Đang mở Dashboard trên trình duyệt..."
open "http://localhost:5200"

echo ""
echo "👉 Dashboard Tiếng Việt đã sẵn sàng tại: http://localhost:5200"
echo "   Endpoint API Proxy: http://127.0.0.1:8317/v1"
echo "=================================================="
