const express = require('express');
const path = require('path');
const { Pool } = require('pg'); // PostgreSQL用の部品
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// === データベース（PostgreSQL）の設定 ===
// Renderの環境変数から接続URLを読み込みます
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // クラウド接続に必要な暗号化設定
});

// テーブルの自動作成（PostgreSQL用の書き方に調整しています）
async function initDB() {
    try {
        // お知らせテーブル
        await pool.query(`
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY,
                title TEXT,
                body TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 既読記録テーブル
        await pool.query(`
            CREATE TABLE IF NOT EXISTS read_logs (
                id SERIAL PRIMARY KEY,
                post_id INTEGER,
                line_user_id TEXT,
                read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(post_id, line_user_id)
            )
        `);

        // ユーザー名簿テーブル
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                line_user_id TEXT PRIMARY KEY,
                name TEXT
            )
        `);

        // テストデータがなければ1件追加する
        const res = await pool.query("SELECT COUNT(*) AS count FROM posts");
        if (parseInt(res.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO posts (title, body) 
                VALUES ('システム公開のお知らせ', '社内掲示板のテスト運用を開始します。よろしくお願いします！')
            `);
        }
        console.log('PostgreSQL（Supabase）に正常に接続・準備完了しました！');
    } catch (err) {
        console.error('データベース初期化エラー:', err);
    }
}
initDB();
// ======================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ユーザー名簿の更新
app.post('/api/sync_user', async (req, res) => {
    const { line_user_id, name } = req.body;
    try {
        await pool.query(`
            INSERT INTO users (line_user_id, name) VALUES ($1, $2)
            ON CONFLICT (line_user_id) DO UPDATE SET name = EXCLUDED.name
        `, [line_user_id, name]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// お知らせ一覧と既読者（名前）の取得
app.get('/api/posts', async (req, res) => {
    try {
        const postsRes = await pool.query("SELECT * FROM posts ORDER BY id DESC");
        const posts = postsRes.rows;

        if (posts.length === 0) return res.json([]);

        const logsRes = await pool.query(`
            SELECT r.post_id, u.name 
            FROM read_logs r
            LEFT JOIN users u ON r.line_user_id = u.line_user_id
        `);
        const logs = logsRes.rows;

        const postsWithReaders = posts.map(post => {
            const readers = logs
                .filter(log => log.post_id === post.id)
                .map(log => log.name || '名前未登録');

            return { ...post, readers: readers };
        });

        res.json(postsWithReaders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 自分が読んだ記事IDリストの取得
app.get('/api/my_reads', async (req, res) => {
    const userId = req.query.line_user_id;
    try {
        const resDb = await pool.query("SELECT post_id FROM read_logs WHERE line_user_id = $1", [userId]);
        const readPostIds = resDb.rows.map(row => row.post_id);
        res.json(readPostIds);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 既読を記録する
app.post('/api/read', async (req, res) => {
    const { post_id, line_user_id } = req.body;
    try {
        await pool.query(`
            INSERT INTO read_logs (post_id, line_user_id) VALUES ($1, $2)
            ON CONFLICT (post_id, line_user_id) DO NOTHING
        `, [post_id, line_user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// === (前略) ===

// ★追加：新しいお知らせを投稿する窓口
// === (前略) ===

// ★書き換え：お知らせを投稿し、LINE通知も一斉送信する
app.post('/api/posts', async (req, res) => {
    const { title, body } = req.body;
    
    if (!title || !body) {
        return res.status(400).json({ error: 'タイトルと本文を入力してください' });
    }

    try {
        // 1. データベースにお知らせを保存
        await pool.query(
            "INSERT INTO posts (title, body) VALUES ($1, $2)",
            [title, body]
        );

        // 2. LINE公式アカウントから友だち全員にプッシュ通知を送信！
        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        if (token) {
            const messageData = {
                messages: [
                    {
                        type: 'text',
                        text: `📢【新しい社内連絡】\n\n■${title}\n${body}\n\n👇確認して「読みました」を押してください\nhttps://liff.line.me/${process.env.LIFF_ID || ''}`
                        // ※URLは後ほど自動リンクになります
                    }
                ]
            };

            // LINEのサーバーに「全員に送信して！」とリクエストを送る
            await fetch('https://api.line.me/v2/bot/message/broadcast', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(messageData)
            });
            console.log('LINE通知を一斉送信しました！');
        }

        res.json({ success: true, message: '投稿＆通知送信が完了しました！' });
    } catch (err) {
        console.error('投稿エラー:', err);
        res.status(500).json({ error: err.message });
    }
});



app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});