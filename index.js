const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY,
                title TEXT,
                body TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS read_logs (
                id SERIAL PRIMARY KEY,
                post_id INTEGER,
                line_user_id TEXT,
                read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(post_id, line_user_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                line_user_id TEXT PRIMARY KEY,
                name TEXT,
                role TEXT DEFAULT 'user'
            )
        `);

        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                post_id INTEGER,
                line_user_id TEXT,
                body TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('PostgreSQL（Supabase）に正常に接続・準備完了しました！');
    } catch (err) {
        console.error('データベース初期化エラー:', err);
    }
}
initDB();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ユーザー名簿の更新と管理者判定
app.post('/api/sync_user', async (req, res) => {
    const { line_user_id, name } = req.body;
    try {
        await pool.query(`
            INSERT INTO users (line_user_id, name, role) VALUES ($1, $2, 'user')
            ON CONFLICT (line_user_id) DO UPDATE SET name = EXCLUDED.name
        `, [line_user_id, name]);

        const userRes = await pool.query(
            "SELECT role FROM users WHERE line_user_id = $1", 
            [line_user_id]
        );
        const role = userRes.rows[0]?.role || 'user';
        const isAdmin = (role === 'admin');

        res.json({ success: true, isAdmin: isAdmin });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// お知らせ一覧、既読者、未読者、コメント一覧の取得
app.get('/api/posts', async (req, res) => {
    try {
        const postsRes = await pool.query("SELECT * FROM posts ORDER BY id DESC");
        const posts = postsRes.rows;

        if (posts.length === 0) return res.json([]);

        const usersRes = await pool.query("SELECT line_user_id, name FROM users");
        const allUsers = usersRes.rows;

        const logsRes = await pool.query(`
            SELECT r.post_id, r.line_user_id, u.name 
            FROM read_logs r
            LEFT JOIN users u ON r.line_user_id = u.line_user_id
        `);
        const logs = logsRes.rows;

        const commentsRes = await pool.query(`
            SELECT c.id, c.post_id, c.body, c.created_at, u.name, u.role
            FROM comments c
            LEFT JOIN users u ON c.line_user_id = u.line_user_id
            ORDER BY c.id ASC
        `);
        const allComments = commentsRes.rows;

        const postsWithStatus = posts.map(post => {
            const postLogs = logs.filter(log => log.post_id === post.id);
            const readUserIds = postLogs.map(log => log.line_user_id);
            const readers = postLogs.map(log => log.name || '名前未登録');

            const unreaders = allUsers
                .filter(user => !readUserIds.includes(user.line_user_id))
                .map(user => user.name || '名前未登録');

            const totalUsers = allUsers.length;
            const readRate = totalUsers > 0 ? Math.round((readers.length / totalUsers) * 100) : 0;
            const postComments = allComments.filter(c => c.post_id === post.id);

            return {
                ...post,
                readers: readers,
                unreaders: unreaders,
                readRate: readRate,
                totalUsers: totalUsers,
                comments: postComments
            };
        });

        res.json(postsWithStatus);
    } catch (err) {
        console.error('取得エラー:', err);
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

// ★神機能：コメント投稿 ＋ 管理者にだけLINE通知を自動送信！
app.post('/api/comments', async (req, res) => {
    const { post_id, line_user_id, body } = req.body;
    if (!body || !body.trim()) {
        return res.status(400).json({ error: 'コメントを入力してください' });
    }

    try {
        // 1. コメントをデータベースに保存
        await pool.query(
            "INSERT INTO comments (post_id, line_user_id, body) VALUES ($1, $2, $3)",
            [post_id, line_user_id, body.trim()]
        );

        // 2. このお知らせのタイトルと、コメントした人の名前を取得
        const postRes = await pool.query("SELECT title FROM posts WHERE id = $1", [post_id]);
        const postTitle = postRes.rows[0]?.title || 'お知らせ';

        const userRes = await pool.query("SELECT name FROM users WHERE line_user_id = $1", [line_user_id]);
        const commenterName = userRes.rows[0]?.name || 'スタッフ';

        // 3. 管理者（role = 'admin'）のLINE ID一覧を全員取得！
        const adminRes = await pool.query("SELECT line_user_id FROM users WHERE role = 'admin'");
        const adminIds = adminRes.rows.map(r => r.line_user_id);

        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const liffUrl = process.env.LIFF_URL;

        // 4. 管理者だけにプッシュ通知（Multicast）を一斉送信！
        if (token && liffUrl && adminIds.length > 0) {
            const flexMessage = {
                type: 'flex',
                altText: `💬【質問・コメント】${commenterName}さんより`,
                contents: {
                    type: 'bubble',
                    header: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: '💬 新しい質問・コメント', weight: 'bold', color: '#0284c7', size: 'sm' },
                            { type: 'text', text: `対象: ${postTitle}`, weight: 'bold', size: 'md', wrap: true, margin: 'sm' }
                        ]
                    },
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: `👤 投稿者: ${commenterName}`, weight: 'bold', size: 'sm', color: '#334155' },
                            { type: 'text', text: body.trim(), wrap: true, size: 'sm', color: '#64748b', margin: 'md' }
                        ]
                    },
                    footer: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [{
                            type: 'button',
                            style: 'primary',
                            color: '#0284c7',
                            height: 'sm',
                            action: { type: 'uri', label: '確認して返信する', uri: liffUrl }
                        }]
                    }
                }
            };

            // multicast API: 指定した人（管理者たち）だけに送るLINEの機能
            await fetch('https://api.line.me/v2/bot/message/multicast', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    to: adminIds,
                    messages: [flexMessage]
                })
            });
            console.log('管理者へ質問通知を送信しました！');
        }

        res.json({ success: true });
    } catch (err) {
        console.error('コメント投稿エラー:', err);
        res.status(500).json({ error: err.message });
    }
});

// お知らせ投稿
app.post('/api/posts', async (req, res) => {
    const { title, body, line_user_id, notify_type } = req.body;

    try {
        const userRes = await pool.query("SELECT role FROM users WHERE line_user_id = $1", [line_user_id]);
        const role = userRes.rows[0]?.role || 'user';
        if (role !== 'admin') {
            return res.status(403).json({ error: '投稿権限がありません（管理者のみ投稿可能です）' });
        }

        if (!title || !body) return res.status(400).json({ error: 'タイトルと本文を入力してください' });

        await pool.query("INSERT INTO posts (title, body) VALUES ($1, $2)", [title, body]);

        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const liffUrl = process.env.LIFF_URL;

        if (notify_type !== 'none' && token && liffUrl) {
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
                        contents: [{ type: 'text', text: body, wrap: true, size: 'sm', color: '#666666' }]
                    },
                    footer: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [{
                            type: 'button',
                            style: 'primary',
                            color: '#00b900',
                            height: 'sm',
                            action: { type: 'uri', label: '確認して「読みました」を押す', uri: liffUrl }
                        }]
                    }
                }
            };

            await fetch('https://api.line.me/v2/bot/message/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ messages: [flexMessage] })
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('投稿エラー:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});