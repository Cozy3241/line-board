const express = require('express');
const app = express();
// 修正前：const port = 3000;
const port = process.env.PORT || 3000; // サーバーが指定するポート、なければ3000


// ブラウザでアクセスした時に表示される内容
app.get('/', (req, res) => {
  res.send('<h1>社内掲示板システム</h1><p>現在開発中です！</p>');
});

// サーバーを起動する
app.listen(port, () => {
  console.log(`サーバーが起動しました：http://localhost:${port}`);
});