# Script chuẩn — transcript-extractor

Chạy từ bất kỳ working directory nào, dùng đường dẫn tới checkout này.

| Mục đích | macOS/Linux | Windows PowerShell |
| --- | --- | --- |
| Development | `bash scripts/dev.sh` | `./scripts/dev.ps1` |
| Production local | `bash scripts/pro.sh` | `./scripts/pro.ps1` |
| Đóng gói dev | `bash scripts/pub-dev.sh` | `./scripts/pub-dev.ps1` |
| Đóng gói production | `bash scripts/pub-pro.sh` | `./scripts/pub-pro.ps1` |

dev chạy Vite; pro build và preview UI extension. Publish giữ `deploy` (build extension + store checks) rồi tạo ZIP cục bộ. Preview UI không thay thế kiểm thử extension trong Chrome.

## Option dùng chung

- Không option: báo lỗi khi có process checkout hoặc port bị chiếm; không tự kill hoặc tự chọn port khác.
- `-f` / `--force`: chỉ cho dev/pro; dừng cây process thuộc checkout và **mọi chủ sở hữu các port cấu hình của lần chạy**, kể cả process dự án khác giữ port đó. Không dừng mọi port trên máy. Kiểm tra lại trước khi chạy.
- `--stop`: chỉ cho dev/pro; dừng cây process thuộc checkout, gồm worker không mở port. Không build, install, clean, đọc/tạo `.env` hoặc dừng chủ sở hữu port ngoài checkout. Không kết hợp `-f`/`--clean`.
- `--clean`: Chỉ xóa cache/build output khai báo trong `settings.json`; không xóa source, dependency, lockfile, `.env` hoặc certificate. Không ngầm force-stop; nếu process checkout đang chạy thì báo lỗi.
- `-h` / `--help`: xem trợ giúp, không thực hiện build hoặc cleanup.
- Option không hợp lệ bị từ chối trước các bước thay đổi trạng thái. Mã lỗi của lệnh build/đóng gói được truyền về caller.

## Port và prerequisites

Port mặc định: 5173. Với React dùng `PORT`; ADM còn có `HTTPS_INTERNAL_PORT`.

Node và package manager theo `package.json`; Unix cần `lsof` và `ps`; Windows cần Windows PowerShell với CIM và `Get-NetTCPConnection`.

Ví dụ restart: `bash scripts/dev.sh -f --clean` hoặc `./scripts/dev.ps1 -f --clean`.

Windows dùng `.ps1`, không có launcher `.bat`. Các tool do SDK/package manager cung cấp vẫn được gọi theo bản cài đặt Windows của tool đó. Trên Unix thử TERM rồi KILL nếu hết thời gian chờ; Windows dùng termination của hệ điều hành.

## Kiểm chứng

Chỉ chạy thử cleanup trên process/port fixture riêng. Không dùng port dịch vụ đang chạy để kiểm chứng. Kiểm tra PowerShell trên macOS không chứng nhận CIM, ACL, mkcert trust hoặc process behavior trên Windows thật.

Nếu máy Windows chặn chạy script theo execution policy, có thể dùng riêng cho lần chạy: `powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/dev.ps1 -f`.

Runtime React ghi lease process tại `.cache/lifecycle.json` để nhận diện launcher dùng đường dẫn tương đối trên Windows và chặn chạy chồng khi chưa mở port. Lease chứa PID/thời điểm tạo process, không chứa cấu hình hoặc secret; lease stale chỉ được bỏ khi identity không còn khớp.
