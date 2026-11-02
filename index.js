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
// お知らせ一覧、既読者、未読者をまとめて計算して送る窓口（書き換え）
app.get('/api/posts', async (req, res) => {
    try {
        const postsRes = await pool.query("SELECT * FROM posts ORDER BY id DESC");
        const posts = postsRes.rows;

        if (posts.length === 0) return res.json([]);

        // 1. 全ユーザー（名簿）を取得
        const usersRes = await pool.query("SELECT line_user_id, name FROM users");
        const allUsers = usersRes.rows;

        // 2. 既読記録を取得
        const logsRes = await pool.query(`
            SELECT r.post_id, r.line_user_id, u.name 
            FROM read_logs r
            LEFT JOIN users u ON r.line_user_id = u.line_user_id
        `);
        const logs = logsRes.rows;

        // 3. 各記事ごとに「読んだ人」と「未読の人」を割り出す
        const postsWithStatus = posts.map(post => {
            // この記事を読んだ人のログ
            const postLogs = logs.filter(log => log.post_id === post.id);
            const readUserIds = postLogs.map(log => log.line_user_id);
            const readers = postLogs.map(log => log.name || '名前未登録');

            // 名簿にいる人のうち、まだ読んでいない人（引き算）
            const unreaders = allUsers
                .filter(user => !readUserIds.includes(user.line_user_id))
                .map(user => user.name || '名前未登録');

            // 既読率の計算（%）
            const totalUsers = allUsers.length;
            const readRate = totalUsers > 0 ? Math.round((readers.length / totalUsers) * 100) : 0;

            return {
                ...post,
                readers: readers,       // 読んだ人の名前リスト
                unreaders: unreaders,   // まだ読んでない人の名前リスト
                readRate: readRate,     // 既読率（例：75）
                totalUsers: totalUsers  // 全員何人いるか
            };
        });

        res.json(postsWithStatus);
    } catch (err) {
        console.error('取得エラー:', err);
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


// ★追加：新しいお知らせを投稿する窓口
// ★書き換え：お知らせを投稿し、LINE通知も一斉送信する


app.post('/api/posts', async (req, res) => {
    const { title, body } = req.body;
    
    if (!title || !body) {
        return res.status(400).json({ error: 'タイトルと本文を入力してください' });
    }

    try {
        await pool.query(
            "INSERT INTO posts (title, body) VALUES ($1, $2)",
            [title, body]
        );

        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const liffUrl = process.env.LIFF_URL; // ★追加：環境変数からLIFF URLを取得

        if (token && liffUrl) {
            // ★変更：LINE公式アカウント特有の「ボタン付きカード型メッセージ（Flex Message）」にする
            const flexMessage = {
                type: 'flex',
                altText: `📢【連絡】${title}`,
                contents: {
                    type: 'bubble',
                    header: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: '社内掲示板', weight: 'bold', color: '#00b900', size: 'sm' },
                            { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, margin: 'md' }
                        ]
                    },
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: body, wrap: true, size: 'sm', color: '#666666' }
                        ]
                    },
                    footer: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                type: 'button',
                                style: 'primary',
                                color: '#00b900',
                                height: 'sm',
                                action: {
                                    type: 'uri',
                                    label: '確認して「読みました」を押す',
                                    uri: liffUrl // ★タップするとLIFF掲示板が開く！
                                }
                            }
                        ]
                    }
                }
            };

            await fetch('https://api.line.me/v2/bot/message/broadcast', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ messages: [flexMessage] })
            });
            console.log('カード型LINE通知を一斉送信しました！');
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