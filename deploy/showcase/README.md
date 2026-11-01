# 产品介绍页、公开下载与评论管理

- 产品页：`https://lovej.site/vibe-logisim/`
- 管理后台：`https://lovej.site/vibe-logisim/admin/`
- 服务器：`ubuntu@lovej.site`
- 独立目录：`/home/ubuntu/apps/vibe-logisim-site`
- 服务：`vibe-showcase`，监听 `127.0.0.1:8811`
- 复用已有 Nginx HTTPS 入口，无需开放额外公网端口；原课堂服务保持 `127.0.0.1:8810`。

`packages/showcase/public/release.json` 固定到实际包含课堂功能的Windows安装包和便携包，记录字节数、SHA-256、构建批次和源版本。应用内版本为0.6.0-beta.3，网站标记课堂协作测试版2026-10-30。没有把未知的旧Release冒充课堂版。

## 部署

在本机构建 `packages/showcase/src/main.mts` 的 Node24 ESM bundle 为 `showcase-server.mjs`，并将 `packages/showcase/public` 打包为 `public.tar.gz`。上传至独立目录的 `incoming/`，同时上传本目录的安装器、Nginx snippet、systemd unit，以及清单对应的实际下载文件。

```sh
python3 /home/ubuntu/apps/vibe-logisim-site/incoming/install.py <发布标识> <bundle的SHA256>
```

安装器验证完整下载文件摘要，创建独立数据目录、独立管理员和私有环境，备份现有评论数据库与配置，再切换发布。Nginx语法检查与服务健康检查成功后才reload。代码发布、下载、数据库分开保存，不改变原课堂数据库和模型密钥。

首次管理员密码通过SSH调用的私有结果保存到本机忽略文件 `.workbench-cache/deploy-showcase/管理员登录信息.txt`。不要把安装器的首次JSON结果打印到公共日志。服务器临时 `first-login.json` 应在本机凭据安全保存后移除；环境中仅保存密码的scrypt派生值。教师账号和教师邀请码不能登录网站管理后台。

## 管理

管理后台支持：待审核/公开/隐藏列表、公开与隐藏恢复、回复、添加“站方发布”内容、显示整个评论区、允许或禁止访客发布。默认访客反馈先审核。不会生成虚构用户好评；站方内容单独标记，不作为独立用户反馈。当前没有评论删除按钮，隐藏保留记录。

```sh
sudo systemctl status vibe-showcase
sudo systemctl restart vibe-showcase
curl http://127.0.0.1:8811/api/health
```

管理员密码需要重置时，在服务器生成新的随机密码，使用同样的scrypt参数生成新的`SHOWCASE_ADMIN_PASSWORD_HASH`，保护环境文件为0600，并删除数据库`admin_sessions`中的旧会话后重启服务。不要公开密码、数据库或IP HMAC私有盐。

下载以流方式提供，支持HTTP Range续传；100 MiB以上文件在当前服务器带宽下需要等待。对外传输可能经过现有代理压缩，不能仅依赖Content-Length推断文件完整性，应校验SHA-256。
