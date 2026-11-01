# lovej.site 课堂服务部署

- 主机：`ubuntu@lovej.site`
- 目录：`/home/ubuntu/apps/vibe-logisim-classroom`
- 客户端服务地址：`https://lovej.site/vibe-classroom`
- 内部监听：`127.0.0.1:8810`，无需向公网开放该端口。
- 对外通过现有 Nginx HTTPS 443；现有证书包含 `lovej.site`。

服务使用目录内的 Node.js 24.21.0，不替换系统 Node。发布目录 `releases/<提交>`，`current` 指向当前发布，数据库和 `.ai-key` 位于 `data/`，环境配置在权限为 0600 的 `classroom.env` 中。没有部署本地演示账号或开发状态。

维护命令：

```sh
sudo systemctl status vibe-classroom
sudo systemctl restart vibe-classroom
sudo journalctl -u vibe-classroom -n 100 --no-pager
curl https://lovej.site/vibe-classroom/api/health
```

更新既有服务时，在本机构建 `packages/classroom/src/main.mts` 的 Node.js 24 ESM bundle，上传为 `incoming/classroom-server.mjs`，同时上传本目录的 `nginx-location.conf` 与 `update.py`。在服务器执行：

```sh
python3 /home/ubuntu/apps/vibe-logisim-classroom/incoming/update.py <提交或发布标识> <bundle的SHA256>
```

脚本先核对 bundle 摘要，使用 SQLite 在线备份 API 备份数据库，并以 0600 权限备份加密密钥与环境文件。随后检查 Nginx 配置、原子切换发布链接、重启服务并检查健康状态。失败时恢复旧发布链接和 Nginx 配置，不会自动恢复数据库，避免覆盖更新期间写入的数据。回退涉及数据格式变化时需先评估兼容性。

2026-10-30 的课堂改版将请求上限提升到 12 MB，支持 gzip、8 MB 电路 XML、模型库、课堂编辑、分析用量预览与报告缓存。数据库保留既有数据，新增内容去重表；新旧完整快照都可由新服务读取。已有客户端仍可手动提交，新客户端启用自动同步并移除自报进度。

教师注册码在 `classroom.env` 的 `CLASSROOM_TEACHER_CODE` 中。教师注册后可自行在客户端发布课堂 AI 配置。教师学情分析另需在该文件中设置完整的 `CLASSROOM_AI_BASE_URL`、`CLASSROOM_AI_API_KEY`、`CLASSROOM_AI_MODEL` 并重启服务。

Nginx 在原 HTTPS server 中引入 `nginx-location.conf` 对应的独立 snippet。修改前保留原配置，`nginx -t` 成功后才 reload。备份数据库时必须同时保留 `data/classroom.sqlite.ai-key`；在线数据库应使用 SQLite backup API，或停服务后备份数据库与密钥。环境文件也应单独安全备份，不要提交凭据到 Git。
