# Quản lý công việc — Phòng Tổ chức Hành chính, Bệnh viện Nhi Đồng 2

Ứng dụng web quản lý nhân sự & công việc cho **Phòng Tổ chức Hành chính - Bệnh viện Nhi Đồng 2**.
Backend Google Apps Script (Web App) + Google Sheets; giao diện một file (SPA), bản beta chạy trên GitHub Pages.

> Đây là một **dự án độc lập hoàn toàn** — script, Google Sheet, deployment và repo riêng,
> KHÔNG dùng chung dữ liệu/hạ tầng với bất kỳ dự án nào khác.

## Cơ cấu nhân sự (1 phòng)

| Vai trò | Mã hệ thống | Quyền |
|---|---|---|
| Trưởng phòng | `TRUONG_PHONG` | Xem & quản lý toàn phòng |
| Phó phòng | `PHO_PHONG` | Xem toàn phòng (trừ cấp cao hơn), quản lý |
| Nhân viên | `CHUYEN_VIEN` | Việc của mình + giao việc cho đồng cấp |
| ADMIN (ẩn) | `ADMIN` | Quyền cao nhất; **không hiển thị ở bất kỳ nơi lưu trữ nào** (credentials ở Script Property) |

> Phòng **Production Crew** đã được gỡ bỏ hoàn toàn khỏi bản này.

## Tài khoản mẫu (đổi PIN/đổi tên ngay sau khi đăng nhập)

| Mã | Vai trò | PIN |
|---|---|---|
| `TP01` | Trưởng phòng | `123456` |
| `PP01` | Phó phòng | `123456` |
| `NV01`, `NV02` | Nhân viên | `123456` |
| `ADMIN` | Quản trị (ẩn) | `291219` |

## Cấu trúc thư mục

```
apps-script/      # Mã nguồn deploy lên Google Apps Script (clasp)
  Code.gs         # Backend (API, phân quyền, dữ liệu)
  Setup.gs        # Khởi tạo sheet + seed nhân sự + migrate
  Index.html      # Vỏ doGet (include Styles + JsClient)
  Styles.html     # CSS (trích từ docs/index.html)
  JsClient.html   # App script (trích từ docs/index.html)
  appsscript.json # Manifest (Web App, Anyone anonymous)
  .clasp.json     # scriptId + ID Google Sheet — KHÔNG commit (gitignore)
docs/index.html   # Bản standalone (GitHub Pages beta) — NGUỒN CHÍNH để sửa client
preview/index.html# Bản xem trước local (dựng từ Styles + JsClient)
build-preview.sh  # Dựng lại preview/index.html
```

## Quy trình build & deploy

Client (sửa giao diện) → sửa **`docs/index.html`**, rồi đồng bộ artifacts:

```bash
# 1) Trích Styles.html + JsClient.html từ docs/index.html
python3 /tmp/extract_gas.py docs/index.html apps-script/Styles.html apps-script/JsClient.html
# 2) Dựng lại preview
bash build-preview.sh
```

Server (Code.gs / Setup.gs): sửa trực tiếp.

Đẩy lên Google Apps Script:

```bash
cd apps-script
clasp push --force
clasp deploy -d "ghi chú phiên bản"   # hoặc redeploy <id>
```

Lần đầu: mở Apps Script editor → chạy hàm **`runSetup`** (tạo sheet + seed nhân sự).

## Bản beta

GitHub Pages: phục vụ `docs/index.html`. Mở trên `github.io` → tự động chạy chế độ
`FetchServer` gọi tới deployment Apps Script (`GAS_EXEC_URL` trong `docs/index.html`).
