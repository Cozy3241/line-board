const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // データベースを使うための準備
const app = express();
const port = process.env.PORT || 3000;

// publicフォルダを公開
app.use(express.static('public'));

// === データベースの設定 ===
// 'database.sqlite'という名前のファイルにデータを保存します
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('データベースを開けません:', err);
    else console.log('データベースに接続しました！');
});

// テーブル（データを整理して入れる表）の作成
db.serialize(() => {
    // もし'posts'という表がなければ作る（id, タイトル, 内容, 日付）
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        body TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // テスト用に、最初から1件だけお知らせを入れておく
    db.get("SELECT COUNT(*) AS count FROM posts", (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO posts (title, body) VALUES ('システム公開のお知らせ', '社内掲示板のテスト運用を開始します。よろしくお願いします！')`);
        }
    });
});
// =========================

// トップページを開いたとき
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// スマホ（フロント側）から「お知らせ一覧ちょうだい！」と呼ばれたときに返す機能
app.get('/api/posts', (req, res) => {
    db.all("SELECT * FROM posts ORDER BY id DESC", (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows); // データベースのデータを送る
    });
});

app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});