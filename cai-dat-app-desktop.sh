#!/usr/bin/env bash
# Script tạo icon ứng dụng Quota Antigravity ra Desktop

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_APP="$HOME/Desktop/Quota Antigravity.app"
APPLICATIONS_APP="/Applications/Quota Antigravity.app"

echo "🔄 Đang tạo ứng dụng Quota Antigravity..."

rm -rf "$DESKTOP_APP" "$APPLICATIONS_APP"
osacompile -e "do shell script \"$DIR/chay-dashboard.sh > /dev/null 2>&1 &\"" -o "$DESKTOP_APP"

if [ -f "$DIR/AppIcon.icns" ]; then
    cp "$DIR/AppIcon.icns" "$DESKTOP_APP/Contents/Resources/applet.icns"
fi

touch "$DESKTOP_APP"
cp -R "$DESKTOP_APP" "$APPLICATIONS_APP"

echo "✅ Đã tạo ứng dụng thành công tại: $DESKTOP_APP"
