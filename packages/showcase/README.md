# 产品介绍页与评论管理

独立的 Node.js 24 + SQLite 服务，不复用教师邀请码或课堂登录权限。页面提供包含课堂功能的固定 Windows 构建、SHA-256、实际界面、使用步骤与反馈入口。截图使用本地合成演示数据。

## 运行与检查

管理员密码只保存 scrypt 派生结果。通过 `passwordHash()` 生成 `SHOWCASE_ADMIN_PASSWORD_HASH`，并设置独立的随机 `SHOWCASE_IP_SECRET`（至少32字符），再运行 `npm run showcase`。不要把真实管理员密码或环境文件提交到 Git。

| 环境变量                                               | 用途                                              |
| ------------------------------------------------------ | ------------------------------------------------- |
| SHOWCASE_DATABASE                                      | SQLite路径，默认 `.showcase-data/showcase.sqlite` |
| SHOWCASE_PUBLIC                                        | public目录                                        |
| SHOWCASE_DOWNLOADS                                     | 经过校验的下载文件目录                            |
| SHOWCASE_ADMIN_USERNAME / SHOWCASE_ADMIN_PASSWORD_HASH | 独立管理员身份                                    |
| SHOWCASE_IP_SECRET                                     | 对限流来源进行HMAC处理的私有盐                    |
| SHOWCASE_ORIGIN                                        | 写请求允许来源，例如 `https://lovej.site`         |
| SHOWCASE_TRUST_PROXY                                   | 仅在受控回环反向代理后设置为1                     |
| SHOWCASE_PORT                                          | 回环监听端口，默认8811                            |

管理入口为 `/vibe-logisim/admin/`。公开留言必须同意公开展示，默认为待审核，管理员可公开、隐藏、恢复和回复；整个评论区和访客发布功能可分别关闭。站方主动添加的内容固定标注“站方发布”，不能冒充独立用户反馈。管理动作记录到审计表。隐藏保留记录，当前没有删除或自动数据保留策略。

采用 HttpOnly/SameSite=Strict Cookie，生产环境增加 Secure；写接口检查来源与JSON类型，公开内容通过 textContent 渲染，限制请求/评论长度与登录尝试。来源仅保存HMAC，不向前端返回。当前匿名反馈采用限流、蜜罐和人工审核，无邮件验证或CAPTCHA。

```sh
npm run test:showcase
npm run check
```

下载构建标签是课堂协作测试版（2026-10-30），应用内版本仍为0.6.0-beta.3。清单固定到实际文件及摘要，不把普通旧GitHub Release作为课堂功能获取地址。新构建使用新文件名，不覆盖已有不可变下载。

服务器安装见 `deploy/showcase/`。评论数据库、私有环境、下载文件与代码发布目录分离，更新前在线备份，失败不自动覆盖数据库。
