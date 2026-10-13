# Cấu hình VSCE_PAT để tự publish AgentTandem

PAT là token cho phép job `publish` đăng extension thay tài khoản của bạn. Bạn tạo token trên Azure DevOps, rồi dán giá trị vào GitHub Secret có tên `VSCE_PAT`.

| Thứ cần điền | Giá trị của dự án |
| --- | --- |
| Publisher ID | `coolbirdv`, nếu đây là publisher bạn sở hữu |
| Tên token trên Azure DevOps | Ví dụ `agent-tandem-github-actions` |
| Tên secret trên GitHub | Chính xác là `VSCE_PAT` |
| Nội dung secret | Chuỗi token Azure DevOps trả về |

Email dùng để đăng nhập; **không** điền email vào Publisher ID hoặc nội dung secret.

## 1. Kiểm tra tài khoản và publisher trên Marketplace

Mở [trang quản lý publisher](https://marketplace.visualstudio.com/manage/publishers/) trong Firefox. Kiểm tra tài khoản đang đăng nhập và chọn publisher của bạn. Tài khoản dùng tạo PAT cần có quyền đăng extension dưới publisher này. Xem [hướng dẫn publisher của Microsoft](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher).

Đừng tạo publisher mới nếu đã có. Workflow hiện mặc định dùng `coolbirdv`. Nếu ID thực tế khác, vào [GitHub Actions Variables](https://github.com/coolbirdzik/agent-tandem/settings/variables/actions), tạo hoặc sửa `MARKETPLACE_PUBLISHER` thành ID đó.

## 2. Mở đúng Azure DevOps

Mở [Azure DevOps](https://dev.azure.com/), đăng nhập bằng cùng tài khoản Microsoft đã dùng trên Marketplace và chọn organization có sẵn.

Nếu tab hiện tại có địa chỉ `portal.azure.com`, đó là **Azure Portal**. Trang tạo PAT nằm trên **Azure DevOps**, tại `dev.azure.com`.

Nếu chưa có organization, xem [cách tạo organization](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/create-organization?view=azure-devops). Microsoft hiện yêu cầu Azure subscription đang hoạt động khi tạo organization mới; hướng dẫn này không tự tạo organization hoặc subscription cho bạn.

## 3. Mở trang Personal access tokens

Trong organization, bấm **User settings** ở góc trên bên phải, gần ảnh đại diện → **Personal access tokens** → **+ New Token**. Không vào **Project settings**.

Token gắn với tài khoản và các quyền tài khoản có sẵn; nó không tự cấp quyền sở hữu publisher. Nguồn: [Microsoft Learn — PAT](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops#create-a-pat).

## 4. Điền form tạo token

| Trường trong form | Chọn/điền |
| --- | --- |
| Name | `agent-tandem-github-actions` |
| Organization | `All accessible organizations` |
| Expiration | Thời hạn ngắn phù hợp; ví dụ 30 ngày |
| Scopes | `Custom defined` |

Bấm **Show all scopes**, tìm **Marketplace**, chọn **Manage**. Không chọn **Full access**. Sau đó bấm **Create**. Đây là cấu hình Marketplace PAT trong [tài liệu VS Code](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).

Nếu không thấy lựa chọn này hoặc bị chặn tạo token, kiểm tra chính sách organization và thời điểm Microsoft ngừng global PAT; không thay bằng token của một organization rồi mặc định coi là tương đương.

Sau khi tạo, **Copy** chuỗi token. Giá trị chỉ được hiển thị một lần; nếu đóng cửa sổ mà chưa lưu, cần tạo token mới. Nguồn: [Microsoft Learn](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops#create-a-pat).

## 5. Dán token vào GitHub

Mở thẳng [Actions Secrets của agent-tandem](https://github.com/coolbirdzik/agent-tandem/settings/secrets/actions).

Hoặc vào repo → **Settings → Secrets and variables → Actions → Secrets**.

1. Bấm **New repository secret**.
2. **Name:** `VSCE_PAT`.
3. **Secret:** dán chuỗi token vừa copy, không thêm dấu nháy.
4. Bấm **Add secret**.

Danh sách cần có tên `VSCE_PAT`; GitHub không hiển thị lại giá trị. Nếu nhập sai, cập nhật secret bằng giá trị mới. Nguồn: [GitHub — tạo repository secret](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-a-repository).

Không dán token vào chat, commit, `package.json`, workflow YAML hoặc tab **Variables**.

## 6. Dùng pipeline của dự án

Không cần chạy `vsce login` trên máy: workflow đọc `${{ secrets.VSCE_PAT }}` và truyền cho VSCE khi publish.

Sau khi commit các thay đổi cần phát hành, trên `main` sạch và đã đồng bộ:

```powershell
git switch main
git pull --ff-only
npm run bump:patch
npm run release
```

`npm run release` đẩy `main` và tag phiên bản, nên chạy khi bạn thực sự muốn phát hành. Xem [luồng release](PUBLISHING.md#automatic-github-releases-and-marketplace-publishing-from-main-tags).

Trong [GitHub Actions](https://github.com/coolbirdzik/agent-tandem/actions), mở run của tag `vX.Y.Z`. Thứ tự là **build → release → Publish to VS Code Marketplace**. Job cuối kiểm tra checksum rồi đăng đúng VSIX đã test. Run thủ công chỉ build package; không dùng nó để kiểm tra rằng publish đã thành công.

Nếu job publish lỗi, xem log trước khi tạo version mới:

| Hiện tượng | Kiểm tra |
| --- | --- |
| Log chuyển sang OIDC dù bạn muốn dùng PAT | Secret `VSCE_PAT` có tồn tại ở đúng repo không? |
| Unauthorized / Forbidden | Token hết hạn, sai quyền hoặc tài khoản thiếu quyền publisher? |
| Publisher sai | `MARKETPLACE_PUBLISHER` có khớp ID thật không? |
| Version đã tồn tại | Workflow có `--skip-duplicate`, cho phép chạy lại |

Nếu GitHub Release đã được tạo, sửa cấu hình rồi **Re-run failed jobs**. Không cần bump thêm version chỉ để thử lại.

## 7. Thời hạn của cách PAT này

`All accessible organizations` là global PAT. Microsoft thông báo các token này ngừng hoạt động từ **01/12/2026**, dù ngày expiration trên token muộn hơn. Cách này chỉ phù hợp để thiết lập tạm trước mốc đó. Nguồn: [thông báo ngừng global PAT](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/).

Workflow cũng có nhánh OIDC khi không có `VSCE_PAT`, nhưng cần cấu hình trusted publishing cho publisher trước. Chỉ xóa/bỏ secret không tự hoàn tất việc chuyển đổi. Xem [hướng dẫn VSCE](https://github.com/microsoft/vscode-vsce#trusted-publishing) và [cấu hình trong dự án](PUBLISHING.md#2-put-the-project-on-github).
