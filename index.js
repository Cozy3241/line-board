const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// === データベースの設定 ===
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('データベースを開けません:', err);
    else console.log('データベースに接続しました！');
});

db.serialize(() => {
    // お知らせテーブル
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        body TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 既読記録テーブル
    db.run(`CREATE TABLE IF NOT EXISTS read_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER,
        line_user_id TEXT,
        read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, line_user_id)
    )`);

    // ★追加：ユーザー名簿テーブル
    db.run(`CREATE TABLE IF NOT EXISTS users (
        line_user_id TEXT PRIMARY KEY,
        name TEXT
    )`);
});
// =========================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ★追加：スマホから「名前」を教えてもらった時に名簿を更新する窓口
app.post('/api/sync_user', (req, res) => {
    const userId = req.body.line_user_id;
    const userName = req.body.name;
    // INSERT OR REPLACE: なければ追加、あれば名前を上書き更新
    db.run(`INSERT OR REPLACE INTO users (line_user_id, name) VALUES (?, ?)`, [userId, userName], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// お知らせ一覧と既読者（名前）を送る窓口
app.get('/api/posts', (req, res) => {
    db.all("SELECT * FROM posts ORDER BY id DESC", (err, posts) => {
        if (err) return res.status(500).json({ error: err.message });
        if (posts.length === 0) return res.json([]);

        // ★変更：read_logs と users を合体させて「名前」を取得する
        const sql = `
            SELECT r.post_id, u.name 
            FROM read_logs r
            LEFT JOIN users u ON r.line_user_id = u.line_user_id
        `;
        db.all(sql, (err, logs) => {
            if (err) return res.status(500).json({ error: err.message });

            const postsWithReaders = posts.map(post => {
                const readers = logs
                    .filter(log => log.post_id === post.id)
                    .map(log => log.name || '名前未登録'); // 名前があれば名前、なければ未登録

                return { ...post, readers: readers };
            });
            res.json(postsWithReaders);
        });
    });
});

// 自分が読んだ記事IDを送る
app.get('/api/my_reads', (req, res) => {
    const userId = req.query.line_user_id;
    db.all("SELECT post_id FROM read_logs WHERE line_user_id = ?", [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => row.post_id));
    });
});

// 既読を記録する
app.post('/api/read', (req, res) => {
    const postId = req.body.post_id;
    const userId = req.body.line_user_id;
    db.run(`INSERT OR IGNORE INTO read_logs (post_id, line_user_id) VALUES (?, ?)`, [postId, userId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});