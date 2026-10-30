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

教师注册码在 `classroom.env` 的 `CLASSROOM_TEACHER_CODE` 中。教师注册后可自行在客户端发布课堂 AI 配置。教师学情分析另需在该文件中设置完整的 `CLASSROOM_AI_BASE_URL`、`CLASSROOM_AI_API_KEY`、`CLASSROOM_AI_MODEL` 并重启服务。

Nginx 在原 HTTPS server 中引入 `nginx-location.conf` 对应的独立 snippet。修改前保留原配置，`nginx -t` 成功后才 reload。备份数据库时必须同时保留 `data/classroom.sqlite.ai-key`；在线数据库应使用 SQLite backup API，或停服务后备份数据库与密钥。环境文件也应单独安全备份，不要提交凭据到 Git。
