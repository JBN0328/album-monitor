const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ===== 已自動填入你的 Discord Webhook 網址 =====
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1544650555555708939/yW6nTPhBQ0atHRp-WGKUZndc-QfP4bRCjVm_U_fMjeITP-y26YaZ4kavaO-CcXbRUVxx";

// 記憶體資料庫
let monitorList = [];

// ===== 發送 Discord 通知函式 =====
async function sendDiscordNotification(item) {
  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      username: "🎵 唱片補貨小助手",
      embeds: [{
        title: "🚨 發現商品有現貨！快搶購！",
        description: `**${item.title}**`,
        url: item.url,
        color: 3066993, // 綠色
        fields: [
          { name: "唱片行", value: item.storeName, inline: true },
          { name: "庫存狀態", value: "✅ 有現貨", inline: true }
        ],
        footer: { text: "唱片補貨監測系統" },
        timestamp: new Date().toISOString()
      }]
    });
    console.log(`[Discord] 已成功發送通知：${item.title}`);
  } catch (error) {
    console.error("[Discord] 發送失敗:", error.message);
  }
}

// ===== 各大唱片行解析器 =====
async function fetchAlbumInfo(url) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
    };

    let title = '未知商品';
    let isOutOfStock = false;
    let storeName = '未知唱片行';

    // 1. 五大唱片
    if (url.includes('5music.com.tw')) {
      storeName = '五大唱片';
      const res = await axios.get(url, { 
        headers: {
          ...headers,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        }, 
        timeout: 10000 
      });
	  
      const $ = cheerio.load(res.data);
      const bodyText = $('body').text().replace(/\s+/g, ' ');

      title = $('title').text().replace('- 五大唱片', '').trim() || '五大唱片商品';

      isOutOfStock = bodyText.includes('目前無現貨') ;
    }
    // 2. 95 樂府
    else if (url.includes('95music.com')) {
      storeName = '95樂府';
      const res = await axios.get(url, { 
        headers: {
          ...headers,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        }, 
        timeout: 10000 
      });
      const $ = cheerio.load(res.data);
      const bodyText = $('body').text().replace(/\s+/g, ' ');
      const bodyHtml = $('body').html() || '';

      const rawTitle = $('.prod_name, .product_name, .title, h1, h2').first().text().trim();
      title = rawTitle || $('title').text().replace('- 95樂府', '').replace('95樂府', '').trim() || title;

      const isStopped = bodyText.includes('本商品停止訂購') || bodyText.includes('暫停訂購');
      const hasCartButton = bodyHtml.includes('cart_add') || 
                            bodyHtml.includes('addcart') || 
                            bodyHtml.includes('購物車') || 
                            bodyHtml.includes('加入購物車');

      isOutOfStock = isStopped || !hasCartButton;
    }
    // 3. 佳佳唱片
    else if (url.includes('ccr.com.tw')) {
      storeName = '佳佳唱片';
      const res = await axios.get(url, { headers, timeout: 10000 });
      const $ = cheerio.load(res.data);
      const bodyHtml = $('body').html() || '';

      const rawTitle = $('.goods_title, .goods_name, h1, h2').first().text().trim();
      if (rawTitle) {
        title = rawTitle;
      } else {
        title = $('title').text().replace('- 佳佳唱片中華路首頁', '').replace('- 佳佳唱片', '').trim();
      }

      const hasBuyButton = bodyHtml.includes('直接購買') || 
                           bodyHtml.includes('buy_btn') || 
                           bodyHtml.includes('addcart');

      isOutOfStock = !hasBuyButton;
    }
    else {
      throw new Error('目前僅支援：五大唱片、95樂府、佳佳唱片');
    }

    return {
      title,
      storeName,
      inStock: !isOutOfStock,
      lastCheck: new Date().toLocaleTimeString('zh-TW')
    };
  } catch (error) {
    console.error(`[解析失敗] ${url}:`, error.message);
    return null;
  }
}

// ===== 背景定時輪詢 (每 3 分鐘) =====
cron.schedule('*/3 * * * *', async () => {
  console.log('\n[自動監測] 開始檢查庫存...');
  for (let item of monitorList) {
    const info = await fetchAlbumInfo(item.url);
    if (info) {
      item.inStock = info.inStock;
      item.lastCheck = info.lastCheck;
      console.log(`- [${info.storeName}] ${info.title} | 狀態: ${info.inStock ? '✅ 有現貨' : '❌ 缺貨中'}`);

      // 只要檢查到有現貨，當下就發送 Discord 通知
      if (info.inStock) {
        console.log(`🚨 【偵測到有現貨】${info.title}`);
        await sendDiscordNotification({ ...item, title: info.title, storeName: info.storeName });
      }
    }
  }
});

// ===== API 路由 =====
app.get('/api/monitors', (req, res) => res.json(monitorList));

app.post('/api/monitors', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '請提供網址' });

  if (monitorList.some(item => item.url === url)) {
    return res.status(400).json({ error: '該網址已在清單中' });
  }

  const info = await fetchAlbumInfo(url);
  if (!info) return res.status(400).json({ error: '無法解析網址' });

  const newItem = {
    id: Date.now().toString(),
    url,
    title: info.title,
    storeName: info.storeName,
    inStock: info.inStock,
    lastCheck: info.lastCheck
  };

  monitorList.push(newItem);

  // 新增成功時，如果當下判定為「有現貨」，立刻發送 Discord 通知
  if (newItem.inStock) {
    console.log(`🚨 【新增商品即時通知】${newItem.title}`);
    await sendDiscordNotification(newItem);
  }

  res.json({ message: '新增成功', item: newItem });
});

// ===== 刪除 API =====
app.delete('/api/monitors/:id', (req, res) => {
  const { id } = req.params;
  monitorList = monitorList.filter(item => item.id !== id);
  res.json({ message: '刪除成功' });
});

// ===== 前端 UI 介面 =====
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>唱片補貨監測站</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 750px; margin: 40px auto; padding: 0 20px; background: #f4f6f8; }
        .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); margin-bottom: 20px; }
        .input-group { display: flex; gap: 10px; margin-top: 10px; }
        input { flex: 1; padding: 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
        button { padding: 12px 20px; background: #5865F2; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
        .item { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding: 12px 0; }
        .badge { padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; margin-right: 8px; }
        .in-stock { background: #e6f4ea; color: #137333; }
        .out-stock { background: #fce8e6; color: #c5221f; }
        .store-tag { font-size: 11px; background: #eee; padding: 2px 6px; border-radius: 4px; margin-right: 6px; }
        .del-btn { background: #ff4d4f; padding: 6px 12px; border-radius: 6px; font-size: 12px; }
      </style>
    </head>
    <body>
      <h1>🎵 唱片行補貨監測站</h1>
      <p>支援唱片行：五大唱片、95樂府、佳佳唱片</p>

      <div class="card">
        <h3>新增監測商品</h3>
        <div class="input-group">
          <input type="text" id="urlInput" placeholder="貼上五大、95樂府或佳佳唱片的商品連結...">
          <button onclick="addMonitor()">開始監測</button>
        </div>
      </div>

      <div class="card">
        <h3>目前監測清單</h3>
        <div id="list">載入中...</div>
      </div>

      <script>
        async function loadList() {
          const res = await fetch('/api/monitors');
          const data = await res.json();
          const listDiv = document.getElementById('list');
          if(data.length === 0) {
            listDiv.innerHTML = '<p style="color:#888;">目前沒有監測中的商品。</p>';
            return;
          }
          listDiv.innerHTML = data.map(item => \`
            <div class="item">
              <div>
                <span class="store-tag">\${item.storeName}</span>
                <strong>\${item.title}</strong><br>
                <small><a href="\${item.url}" target="_blank">查看頁面</a> | 上次檢查: \${item.lastCheck}</small>
              </div>
              <div>
                <span class="badge \${item.inStock ? 'in-stock' : 'out-stock'}">
                  \${item.inStock ? '✅ 有現貨' : '❌ 缺貨中'}
                </span>
                <button class="del-btn" onclick="deleteMonitor('\${item.id}')">移除</button>
              </div>
            </div>
          \`).join('');
        }

        async function addMonitor() {
          const url = document.getElementById('urlInput').value;
          if(!url) return alert('請輸入網址');
          
          const res = await fetch('/api/monitors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
          });
          const data = await res.json();
          if(res.ok) {
            document.getElementById('urlInput').value = '';
            loadList();
          } else {
            alert(data.error);
          }
        }

        async function deleteMonitor(id) {
          await fetch('/api/monitors/' + id, { method: 'DELETE' });
          loadList();
        }

        loadList();
        setInterval(loadList, 10000);
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 監測伺服器已啟動: http://localhost:${PORT}`);
  
  // ===== 啟動時自動發送一次測試訊息 =====
  console.log("正在發送測試訊息至你的 Discord 頻道...");
  await sendDiscordNotification({
    title: "【連線測試】唱片監測系統已成功啟動！",
    url: "http://localhost:3000",
    storeName: "系統通知"
  });
});