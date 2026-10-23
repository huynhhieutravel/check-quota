# Quota Antigravity Dashboard

Hệ thống giám sát, đồng bộ hạn mức và điều phối luồng tài khoản Google Gemini / Claude cho Antigravity IDE qua proxy core.

## Language

**Live IDE Quota**:
Hạn mức thời gian thực lấy trực tiếp qua LanguageServer RPC của các cửa sổ Antigravity IDE đang mở trên macOS.
_Avoid_: Local quota, IDE status, memory quota

**Daily Quota**:
Hạn mức truy vấn từ Google CloudCode API (`daily-cloudcode-pa`) cho các tài khoản không mở giao diện IDE.
_Avoid_: Remote quota, cloud quota, direct quota

**Five-Hour Limit** (`gemini-5h`):
Hạn mức sử dụng trong khung cửa sổ trượt 5 giờ nhằm điều tiết nhu cầu tài nguyên chung.
_Avoid_: Hourly quota, short-term limit, 5h block

**Weekly Limit** (`gemini-weekly`):
Hạn mức định kỳ 7 ngày được cấp theo gói tài khoản (Google AI Pro/Ultra).
_Avoid_: Long-term limit, month quota, weekly bucket

**Account Pool**:
Tập hợp toàn bộ các tài khoản OAuth được lưu trữ trong thư mục cấu hình của `cli-proxy-api`.
_Avoid_: Account list, user list, proxy accounts

**Quota Snapshot**:
Bản ghi trạng thái hạn mức gần nhất được lưu bền vững vào đĩa để tránh mất dữ liệu khi IDE đóng.
_Avoid_: Cache, backup state, quota log
