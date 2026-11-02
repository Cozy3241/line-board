const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = process.env.PORT || 3000;

// ★追加：画面から送られてくるデータ（JSON）を受け取るための設定
app.use(express.json());
app.use(express.static('public'));

// === データベースの設定 ===
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('データベースを開けません:', err);
    else console.log('データベースに接続しました！');
});

db.serialize(() => {
    // お知らせを入れる箱（前回作成）
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        body TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ★追加：誰が読んだかを記録する箱（テーブル）
    // UNIQUE をつけることで「同じ人が同じ記事のボタンを2回押しても、1回とカウントする」ようになります
    db.run(`CREATE TABLE IF NOT EXISTS read_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER,
        line_user_id TEXT,
        read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, line_user_id)
    )`);

    // テストデータ
    db.get("SELECT COUNT(*) AS count FROM posts", (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO posts (title, body) VALUES ('システム公開のお知らせ', '社内掲示板のテスト運用を開始します。よろしくお願いします！')`);
        }
    });
});
// =========================

// トップページ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// お知らせ一覧と、その記事を読んだ人のリストを送る窓口（書き換え）
app.get('/api/posts', (req, res) => {
    // 1. まずはお知らせ一覧を取得
    db.all("SELECT * FROM posts ORDER BY id DESC", (err, posts) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (posts.length === 0) return res.json([]); // 記事がない場合

        // 2. 既読者リストも取得する
        db.all("SELECT post_id, line_user_id FROM read_logs", (err, logs) => {
            if (err) return res.status(500).json({ error: err.message });

            // 3. お知らせデータに「読んだ人リスト(readers)」をくっつける
            const postsWithReaders = posts.map(post => {
                // この記事(post.id)の既読記録だけを抽出
                const readers = logs
                    .filter(log => log.post_id === post.id)
                    .map(log => log.line_user_id); // ひとまずLINEのIDをリストにする

                return {
                    ...post,
                    readers: readers // readers: ['U123...', 'U456...'] という形になる
                };
            });

            // 合体させたデータを送る
            res.json(postsWithReaders);
        });
    });
});


// ★追加：「読みました」を受け取って記録する窓口
app.post('/api/read', (req, res) => {
    // スマホの画面から「記事のID」と「読んだ人のLINE ID」が送られてきます
    const postId = req.body.post_id;
    const userId = req.body.line_user_id;

    // データベースに記録する（INSERT OR IGNORE で、すでに記録があれば無視する）
    db.run(`INSERT OR IGNORE INTO read_logs (post_id, line_user_id) VALUES (?, ?)`, 
    [postId, userId], 
    function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: '既読を記録しました！' });
    });
});


// ★追加：「自分が読んだ記事のIDリスト」を返す窓口
app.get('/api/my_reads', (req, res) => {
    // 誰からの質問か（LINE ID）を受け取る
    const userId = req.query.line_user_id;
    
    // データベースから、この人が読んだpost_idを探す
    db.all("SELECT post_id FROM read_logs WHERE line_user_id = ?", [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // 扱いやすいように [1, 2, 5] のような数字のリストにして返す
        const readPostIds = rows.map(row => row.post_id);
        res.json(readPostIds);
    });
});


app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});