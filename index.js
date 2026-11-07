const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

// ファイルアップロード対応のためJSONサイズ制限を50MBに拡張
app.use(express.json({ limit: '50mb' }));
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
            ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false
        `);

        // 添付ファイル用カラムの自動追加
        await pool.query(`
            ALTER TABLE posts ADD COLUMN IF NOT EXISTS attachment_url TEXT;
            ALTER TABLE posts ADD COLUMN IF NOT EXISTS attachment_name TEXT;
            ALTER TABLE posts ADD COLUMN IF NOT EXISTS attachment_type TEXT;
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

// スマホに環境変数のLIFF IDを安全に渡す窓口
app.get('/api/config', (req, res) => {
    res.json({ liffId: process.env.LIFF_ID });
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

// 📎 Supabase StorageへのファイルアップロードAPI
app.post('/api/upload', async (req, res) => {
    const { fileData, fileName, fileType, line_user_id } = req.body;

    try {
        const userRes = await pool.query("SELECT role FROM users WHERE line_user_id = $1", [line_user_id]);
        if (userRes.rows[0]?.role !== 'admin') {
            return res.status(403).json({ error: 'アップロード権限がありません（管理者のみ）' });
        }

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ error: 'Renderの環境変数（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）が未設定です。' });
        }

        // Base64をバイナリBufferに変換
        const base64Content = fileData.split(';base64,').pop();
        const buffer = Buffer.from(base64Content, 'base64');

        // 重複しない英数字ファイル名を生成
        const ext = path.extname(fileName) || (fileType.includes('pdf') ? '.pdf' : '.jpg');
        const uniqueFileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;

        // Supabase Storage REST API へ保存（apikey と Authorization の両方を付与）
        const uploadUrl = `${supabaseUrl}/storage/v1/object/attachments/${uniqueFileName}`;
        const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': fileType
            },
            body: buffer
        });

        if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            throw new Error(`Supabase Storage 保存失敗: ${errText}`);
        }

        // 公開URLを生成
        const publicUrl = `${supabaseUrl}/storage/v1/object/public/attachments/${uniqueFileName}`;

        res.json({
            success: true,
            url: publicUrl,
            fileName: fileName,
            fileType: fileType.includes('pdf') ? 'pdf' : 'image'
        });
    } catch (err) {
        console.error('アップロードエラー:', err);
        res.status(500).json({ error: err.message });
    }
});

// お知らせ一覧
app.get('/api/posts', async (req, res) => {
    try {
        const postsRes = await pool.query("SELECT * FROM posts WHERE is_deleted = false ORDER BY id DESC");
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

// 既読リスト取得
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

// 既読記録
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

// コメント投稿
app.post('/api/comments', async (req, res) => {
    const { post_id, line_user_id, body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'コメントを入力してください' });

    try {
        await pool.query(
            "INSERT INTO comments (post_id, line_user_id, body) VALUES ($1, $2, $3)",
            [post_id, line_user_id, body.trim()]
        );

        const postRes = await pool.query("SELECT title FROM posts WHERE id = $1", [post_id]);
        const postTitle = postRes.rows[0]?.title || 'お知らせ';

        const userRes = await pool.query("SELECT name FROM users WHERE line_user_id = $1", [line_user_id]);
        const commenterName = userRes.rows[0]?.name || 'スタッフ';

        const adminRes = await pool.query("SELECT line_user_id FROM users WHERE role = 'admin'");
        const adminIds = adminRes.rows.map(r => r.line_user_id);

        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const liffUrl = process.env.LIFF_URL;

        if (token && liffUrl && adminIds.length > 0) {
            const targetUrl = `${liffUrl}?postId=${post_id}`;
            const flexMessage = {
                type: 'flex',
                altText: `💬【質問】No.${post_id} ${commenterName}さんより`,
                contents: {
                    type: 'bubble',
                    header: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: '💬 新しい質問・コメント', weight: 'bold', color: '#0284c7', size: 'sm' },
                            { type: 'text', text: `対象: 【No.${post_id}】${postTitle}`, weight: 'bold', size: 'md', wrap: true, margin: 'sm' }
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
                            action: { type: 'uri', label: '確認して返信する', uri: targetUrl }
                        }]
                    }
                }
            };

            await fetch('https://api.line.me/v2/bot/message/multicast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ to: adminIds, messages: [flexMessage] })
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('コメント投稿エラー:', err);
        res.status(500).json({ error: err.message });
    }
});

// お知らせ新規投稿（添付ファイル情報対応 & Flex画像連携）
app.post('/api/posts', async (req, res) => {
    const { title, body, line_user_id, notify_type, attachment_url, attachment_name, attachment_type } = req.body;

    try {
        const userRes = await pool.query("SELECT role FROM users WHERE line_user_id = $1", [line_user_id]);
        const role = userRes.rows[0]?.role || 'user';
        if (role !== 'admin') {
            return res.status(403).json({ error: '投稿権限がありません（管理者のみ投稿可能です）' });
        }

        if (!title || !body) return res.status(400).json({ error: 'タイトルと本文を入力してください' });

        const insertRes = await pool.query(
            `INSERT INTO posts (title, body, attachment_url, attachment_name, attachment_type) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`, 
            [title, body, attachment_url || null, attachment_name || null, attachment_type || null]
        );
        const newPostId = insertRes.rows[0].id;

        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const liffUrl = process.env.LIFF_URL;

        if (notify_type !== 'none' && token && liffUrl) {
            const targetUrl = `${liffUrl}?postId=${newPostId}`;

            const bubbleContents = {
                type: 'bubble',
                header: {
                    type: 'box',
                    layout: 'vertical',
                    contents: [
                        { type: 'text', text: '社内掲示板', weight: 'bold', color: '#00b900', size: 'sm' },
                        { type: 'text', text: `【No.${newPostId}】${title}`, weight: 'bold', size: 'lg', wrap: true, margin: 'md' }
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
                    contents: [{
                        type: 'button',
                        style: 'primary',
                        color: '#00b900',
                        height: 'sm',
                        action: { type: 'uri', label: '確認して「読みました」を押す', uri: targetUrl }
                    }]
                }
            };

            // 画像添付があればFlexカード上部に画像（hero）を追加
            if (attachment_url && attachment_type === 'image') {
                bubbleContents.hero = {
                    type: 'image',
                    url: attachment_url,
                    size: 'full',
                    aspectRatio: '20:13',
                    aspectMode: 'cover',
                    action: { type: 'uri', uri: targetUrl }
                };
            } else if (attachment_url && attachment_type === 'pdf') {
                bubbleContents.body.contents.push({
                    type: 'text',
                    text: '📄 添付資料（PDF）あり',
                    weight: 'bold',
                    color: '#dc2626',
                    size: 'xs',
                    margin: 'md'
                });
            }

            const flexMessage = {
                type: 'flex',
                altText: `📢【連絡 No.${newPostId}】${title}`,
                contents: bubbleContents
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

// 論理削除
app.post('/api/posts/delete', async (req, res) => {
    const { post_id, line_user_id } = req.body;

    try {
        const userRes = await pool.query("SELECT role FROM users WHERE line_user_id = $1", [line_user_id]);
        if (userRes.rows[0]?.role !== 'admin') {
            return res.status(403).json({ error: '削除権限がありません（管理者のみ可能です）' });
        }

        await pool.query("UPDATE posts SET is_deleted = true WHERE id = $1", [post_id]);
        res.json({ success: true });
    } catch (err) {
        console.error('削除エラー:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
  console.log(`サーバー起動：http://localhost:${port}`);
});