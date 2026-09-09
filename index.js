const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// publicというフォルダの中身を公開するように設定
app.use(express.static('public'));

// 起動時に一番最初に表示するページ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});