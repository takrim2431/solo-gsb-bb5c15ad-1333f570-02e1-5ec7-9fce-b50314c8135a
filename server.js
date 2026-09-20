/**
 * 套色偏移校准服务
 * 仅负责托管静态前端与健康检查；所有图像处理均在浏览器 Canvas 中完成，
 * 上传图片不会写入磁盘或上传到服务器。
 */
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, HOST, () => {
  console.log(`套色校准应用已启动: http://localhost:${PORT}`);
});
