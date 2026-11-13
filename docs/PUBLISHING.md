# 发布到 GitHub（第一次也照做）

这份文档写给第一次把项目放到 GitHub 的人。按顺序执行即可，不需要先懂 Git。

仓库根目录已经准备好了：

- `.gitignore`：排除 `node_modules/`、日志、系统垃圾文件
- `LICENSE`：MIT
- `CHANGELOG.md`：版本变更
- `.github/workflows/ci.yml`：每次 push 自动跑语法检查和单元测试

---

## 0. 准备

### 安装 Git

Windows 上打开 PowerShell，确认已经安装：

```powershell
git --version
```

没有输出或提示找不到命令，就先安装 [Git for Windows](https://git-scm.com/download/win)，然后**重新打开** PowerShell。

### 设置提交身份

```powershell
git config --global user.name "你的名字或昵称"
git config --global user.email "你的邮箱"
```

邮箱不必和 GitHub 一致，但建议用 GitHub 账号绑定的邮箱，这样提交会显示在你的头像下。

### 确认项目里没有依赖目录

```powershell
cd E:\dshWorkspace\dsh-job-notify
git status
```

如果项目还不是 Git 仓库，这一步会提示 `not a git repository`，属于正常，下一步会初始化。

---

## 1. 在 GitHub 网页创建仓库

1. 登录 [github.com](https://github.com)，点右上角 **+** → **New repository**。
2. **Repository name** 填 `dsh-job-notify`。
3. 选择 **Public**（想先私有也可以，之后随时改）。
4. **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license" —— 本地已经有这些文件，勾选会产生一次冲突提交。
5. 点 **Create repository**。

创建完成后，页面会显示仓库地址，形如：

```
https://github.com/你的用户名/dsh-job-notify.git
```

---

## 2. 在本地初始化并提交

在项目目录执行：

```powershell
cd E:\dshWorkspace\dsh-job-notify
git init -b main
git add .
git status
```

**先看 `git status` 的输出**，确认列表里没有 `node_modules/`。如果看到了，说明 `.gitignore` 没有生效，先停下来检查文件名和位置。

确认无误后：

```powershell
git commit -m "feat: dsh-job-notify v1.2.0"
```

---

## 3. 关联远程仓库并推送

把下面的 `你的用户名` 换成 GitHub 用户名：

```powershell
git remote add origin https://github.com/你的用户名/dsh-job-notify.git
git push -u origin main
```

### 推送时要求输入密码？

GitHub 从 2021 年起不再接受账号密码，必须用 **Personal Access Token（PAT）**，或者用 GitHub Desktop / GitHub CLI 登录。

**方式 A：用 token（命令行）**

1. GitHub → 右上头像 → **Settings** → 左侧最下 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. 名称随便填，有效期选 30 天或 90 天。
3. **Repository access** 选 "Only select repositories"，选中 `dsh-job-notify`。
4. **Permissions → Repository permissions → Contents** 选 **Read and write**。
5. 生成后复制 token（只显示一次）。
6. 回到 `git push`，用户名填 GitHub 用户名，密码粘贴 token。

**方式 B：用 GitHub Desktop（不碰命令行认证）**

1. 安装并登录 [GitHub Desktop](https://desktop.github.com/)。
2. **File → Add local repository**，选择 `E:\dshWorkspace\dsh-job-notify`。
3. 点右上角 **Publish repository**，取消勾选 "Keep this code private"（如果想公开），发布。

**方式 C：用 GitHub CLI**

```powershell
winget install GitHub.cli
gh auth login
gh repo create dsh-job-notify --public --source . --remote origin --push
```

---

## 4. 仓库地址

本仓库已经指向 `imnotRiv3r/dsh-job-notify`。如果你 fork 后重新发布，把中英文 README 里的克隆地址和 `package.json` 的 `repository` 换成你的用户名即可。

`package.json` 里已经包含仓库元数据（`npm` 和部分工具会读取）：

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/你的用户名/dsh-job-notify.git"
},
"homepage": "https://github.com/你的用户名/dsh-job-notify#readme",
"bugs": {
  "url": "https://github.com/你的用户名/dsh-job-notify/issues"
}
```

然后：

```powershell
git add README.md README.zh-CN.md package.json
git commit -m "docs: point links at the published repository"
git push
```

---

## 5. 打版本标签和 Release

```powershell
git tag -a v1.2.0 -m "dsh-job-notify v1.2.0"
git push origin v1.2.0
```

回到 GitHub 仓库页面：

1. 右侧 **Releases** → **Draft a new release**。
2. **Choose a tag** 选择 `v1.2.0`。
3. 标题填 `v1.2.0`。
4. 描述直接粘贴 `CHANGELOG.md` 里 `## [1.2.0]` 这一节。
5. 点 **Publish release**。

### 顺手把仓库首页收拾一下

1. 仓库页面右侧 **About** 旁的齿轮 → **Description** 填一句英文简介：

   ```
   Native Windows notifications for DeepSeek Harness when a background job settles or a conversation turn ends.
   ```

2. **Topics** 填 `deepseek-harness`、`dsh`、`dsh-plugin`、`windows`、`notification`、`cordis`。
3. 确认 README 里的两张通知截图和配置页截图都能正常显示（它们随 `git add .` 一起提交了）。

---

## 6. 以后怎么更新

```powershell
cd E:\dshWorkspace\dsh-job-notify
npm test
git add .
git commit -m "fix: 描述这次改了什么"
git push
```

发新版本时同步做三件事：

1. 改 `package.json` 的 `version`
2. 在 `CHANGELOG.md` 顶部加一节
3. 打新 tag 并 push

---

## 5.5 发到 npm（2026 起需要 2FA）

npm 现在对 `auth-and-writes` 账号强制交互式 2FA，**`npm login --auth-type=web` 拿到的 token 不能发布**，会一直返回：

```
E403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

这时 `--otp=` 也不起作用（错误码不变），因为 web 登录 token 不参与 OTP 校验。两条可用的路：

**方式 A：临时发布 token（最快）**

1. 打开 <https://www.npmjs.com/settings/imnotriv3r/tokens> → **Create token**。
2. 类型选 **Granular Access Token**，有效期设 **1 天**。
3. Permissions 选 **Read and write**，Packages 勾 `dsh-job-notify`。
4. 勾 **Bypass two-factor authentication**（npm 计划 2027 年 1 月才收回这个能力）。
5. 把 token 写进 `~/.npmrc` 代替旧的行，然后 `npm publish`。
6. 发完立刻把 token 换回原值，再到网页 revoke 它。

**方式 B：trusted publishing（OIDC，长期方案）**

仓库里放 `.github/workflows/publish.yml`，用 `id-token: write` + `actions/setup-node`，`npm publish --provenance`，不需要任何 token。前提是在 npm 包设置里登记可信发布者：包页 → Settings → **Trusted publishing** → GitHub Actions，owner `imnotRiv3r`、repository `dsh-job-notify`、workflow 文件名。

**发布后不要立刻断言失败**：registry 会先返回

```
npm notice Your package is being processed and may take a few minutes to become available.
```

元数据里先出现新版本号，tarball 还要再过几分钟才可下载。用

```powershell
npm view dsh-job-notify dist-tags
Invoke-WebRequest -Method Head https://registry.npmjs.org/dsh-job-notify/-/dsh-job-notify-1.3.2.tgz
```

确认 `latest` 已切换、tarball 返回 200，再让用户升级。

---

## 常见问题

| 问题 | 处理 |
|---|---|
| `git push` 提示 `remote origin already exists` | `git remote set-url origin https://github.com/你的用户名/dsh-job-notify.git` |
| 误提交了 `node_modules` | `git rm -r --cached node_modules`，确认 `.gitignore` 后重新提交 |
| 提交里出现中文乱码文件名 | 一般不影响；确保文件本身是 UTF-8 |
| 想在两台机器上改 | `git clone` 到另一台，改完 `git pull` / `git push` |
| CI 红了 | 本地先跑 `npm run check` 和 `npm test`，看输出里第一个失败项 |
| 不想公开 | 仓库 Settings → 最下方 **Change visibility** → Private |
