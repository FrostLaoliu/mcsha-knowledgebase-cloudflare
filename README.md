# MC杀 · 开发资料库

面向小团队的共享游戏开发资料库。前端使用 React + TypeScript + Vite，API 使用 Cloudflare Pages Functions，数据存储在 Cloudflare D1。

## 当前功能

- 登录系统：不提供公开注册；账号只能由管理员创建。
- 角色卡片：角色名、血量、分类、介绍、多个词条。
- 玩法流程：分类、摘要、步骤、开发备注。
- 协作记录：记录创建者、编辑者、修改说明与历史快照。
- 管理后台：创建成员账号、停用/启用账号、重置密码。
- 图片资源管理：管理员可上传、预览、复制图片地址和删除图片；图片存放在 Cloudflare R2，单张限制 5 MB。
- 所有登录成员可以查看和编辑共享内容；管理员额外管理账号。
- 暗色响应式界面，适配桌面与手机。

## 部署到 Cloudflare

### 1. 安装环境

需要 Node.js 20+、npm 和一个 Cloudflare 账号。建议先在本地运行：

```bash
npm install
npm run dev
```

本地前端可以打开，但登录 API 需要 Cloudflare Pages Functions 和 D1；部署配置后再验证完整流程。

### 2. 创建 D1 数据库

```bash
npx wrangler login
npx wrangler d1 create mcsha-codex-db
```

命令会返回 `database_id`。把它填入 `wrangler.toml` 的 `database_id`，替换掉 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。

应用初始数据库结构：

```bash
npx wrangler d1 migrations apply mcsha-codex-db --remote
```

### 3. 设置首个管理员密码

`wrangler.toml` 默认管理员用户名为 `admin`。设置一个至少 12 位的初始密码，不要把密码提交到 Git：

```bash
npx wrangler pages secret put BOOTSTRAP_ADMIN_PASSWORD
```

按提示输入高强度密码。首次 API 请求时，系统会在数据库中创建管理员（仅当该用户名还不存在时）。首次部署后请立即登录验证。

如果希望修改管理员用户名，在 `wrangler.toml` 中修改 `BOOTSTRAP_ADMIN_USERNAME` 后重新部署；初始化完成后，修改该变量不会重命名已经存在的账号。

### 4. 配置图片存储（R2）

管理员图片上传使用 Cloudflare R2 对象存储，文件不存入 D1。

1. 在 Cloudflare 控制台进入 **R2 Object Storage**，创建名称为 `mcsha-codex-assets` 的存储桶（名称需与 `wrangler.toml` 一致）。
2. 仓库的 `wrangler.toml` 已预留 `ASSETS` 绑定。部署时确认 Pages 项目使用该配置，且 R2 bucket binding 名称为 `ASSETS`。
3. 重新部署后，以管理员身份进入“管理后台”即可上传、预览、复制图片链接和删除资源。

接口仅允许管理员列出、上传或删除图片；图片访问要求登录。当前接受 PNG、JPEG、WebP、GIF，单张最大 5 MB。未配置 R2 时，管理后台会显示明确提示并禁用上传按钮。不要将图片内容或凭据提交到 Git。

### 5. 部署

```bash
npm install
npm run build
npx wrangler pages project create mcsha-codex
npx wrangler pages deploy dist --project-name mcsha-codex
```

若项目已在 Cloudflare Pages 创建，跳过 `pages project create`。也可以把 GitHub 仓库连接到 Cloudflare Pages，构建命令填写 `npm run build`，输出目录填写 `dist`。确保 Pages 项目绑定 D1 数据库，绑定名称必须是 `DB`，并设置 `BOOTSTRAP_ADMIN_PASSWORD` secret。使用 Wrangler 部署时，`wrangler.toml` 会声明 D1 绑定。

部署后访问 Cloudflare 提供的 `*.pages.dev` 地址，以 `admin` 登录；进入管理后台创建同学账号。成员账号密码至少 12 位。

## 安全说明

- 密码使用 PBKDF2-SHA-256（310,000 次迭代）加盐哈希，不存明文。
- 会话 token 只以 SHA-256 摘要存数据库，Cookie 使用 HttpOnly、Secure、SameSite=Lax。
- 管理员权限在服务端验证，不依赖前端隐藏按钮。
- 建议启用 Cloudflare 的速率限制/WAF，并定期备份 D1。
- 当前版本没有公开注册、邮件找回、头像上传和删除内容功能。
- 内容编辑是共享协作模式：所有已登录成员都可编辑角色和玩法；历史版本可查看但界面暂不支持一键恢复。
- `wrangler.toml` 的数据库 ID 必须填写真实值，不能直接照抄占位符。
- `BOOTSTRAP_ADMIN_PASSWORD` 必须通过 Cloudflare secret 设置，不要写进代码、`.env` 提交或聊天群。

## 目录结构

```text
functions/api/[[path]].ts   # Cloudflare Pages API
migrations/                 # D1 数据库迁移
src/App.tsx                 # 页面与交互
src/style.css               # 暗色 UI
wrangler.toml               # Cloudflare Pages / D1 绑定
```
