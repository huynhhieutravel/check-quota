# Hệ Thống Giám Sát & Quản Lý Quota Antigravity (100% Tiếng Việt)

Dự án này đã được cấu hình và xây dựng riêng một **Giao diện Web Dashboard thuần Tiếng Việt 100%**, giúp bạn quản lý nhiều tài khoản Google Gemini Pro / Antigravity một cách trực quan, hoàn toàn không cần nhìn chữ tiếng Trung.

---

## 1. Cách Mở Dashboard Tiếng Việt (1-Click)

Chạy lệnh sau trong thư mục này:
```bash
./chay-dashboard.sh
```
Hệ thống sẽ:
1. Đóng ứng dụng giao diện tiếng Trung.
2. Đảm bảo Core Proxy chạy ổn định ở cổng `http://127.0.0.1:8317`.
3. Tự động bật giao diện Web Tiếng Việt và mở trình duyệt tới: **http://localhost:5200**.

---

## 2. Các Tính Năng Trên Giao Diện Tiếng Việt

* **➕ Nút "Thêm Tài Khoản Mới":**
  * Nhấn vào nút này, hệ thống sẽ tự động mở trang đăng nhập Google trong trình duyệt.
  * Chọn tài khoản Google có Gemini Pro để cấp quyền.
  * Đăng nhập xong, tài khoản sẽ tự động xuất hiện trên danh sách Dashboard.
  * Bạn có thể bấm tiếp để đăng nhập tài khoản thứ 2, thứ 3, v.v.

* **📊 Thanh đo Quota & Thời Gian Reset:**
  * Mỗi tài khoản hiển thị dạng Card riêng biệt.
  * Thanh đo % dung lượng Quota khả dụng (đổi màu Xanh / Vàng / Đỏ theo hạn mức).
  * Thời gian đếm ngược: Biết chính xác còn bao nhiêu giờ/phút nữa tài khoản sẽ hồi phục Quota.
  * Nút "Xóa" để gỡ bỏ tài khoản khỏi danh sách khi không dùng nữa.

* **🔄 Nút "Làm Mới Quota":**
  * Tự động gửi yêu cầu kiểm tra thời gian thực tới Google Cloud Code để cập nhật số % mới nhất.
  * Hệ thống cũng tự động làm mới ngầm mỗi 30 giây.

* **⚡ Cổng API Proxy Tự Động Xoay Tua:**
  * Link endpoint: `http://127.0.0.1:8317/v1`
  * Bấm vào ô link để copy nhanh.
  * Dùng link này trong các tool/agent (Roo Code, Cline, Cursor, Continue,...). Khi tài khoản A hết quota (lỗi 429), proxy sẽ tự động chuyển request sang tài khoản B.

---

## 3. Các File Trong Thư Mục Này

* `chay-dashboard.sh`: File chạy mở Dashboard Tiếng Việt.
* `server.mjs`: Server Node.js xử lý API và bóc tách Quota từ Google.
* `public/index.html`: Giao diện Dashboard Tiếng Việt (Giao diện Dark Mode hiện đại).
* `status.sh`: Script kiểm tra trạng thái tiến trình qua terminal.
