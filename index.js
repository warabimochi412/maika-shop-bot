/**
 * maika販売所 - 刺身風 OwO Cowoncy 自販機Bot
 * コピペ用・1ファイル完結
 *
 * 必要パッケージ: discord.js dotenv
 * 起動: node index.js
 *
 * 【注意】DELIVERY_USER_TOKENS による owo give は
 * Discord利用規約違反（セルフボット）となりBANリスクがあります。自己責任で。
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
require('dotenv').config();

// ========== 設定（環境変数） ==========
const config = {
  token: process.env.DISCORD_TOKEN || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  shopChannelId: process.env.SHOP_CHANNEL_ID || '',
  historyChannelId: process.env.HISTORY_CHANNEL_ID || '', // 送信履歴チャンネル（任意）
  deliveryUserTokens: (process.env.DELIVERY_USER_TOKENS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  deliveryChannelId: process.env.DELIVERY_CHANNEL_ID || '',
  pricePer100k: Number(process.env.PRICE_PER_100K) || 10,
  minPurchase: Number(process.env.MIN_PURCHASE) || 10000,
  purchaseUnit: Number(process.env.PURCHASE_UNIT) || 10000,
  dailyLimit: Number(process.env.DAILY_LIMIT) || 100000000,
  paymentTimeoutSeconds: Number(process.env.PAYMENT_TIMEOUT_SECONDS) || 120,
  webhookSecret: process.env.WEBHOOK_SECRET || 'change-me-to-random-string',
  botName: 'maika販売所',
};

const PORT = Number(process.env.PORT) || 8080;
const DATA_PATH = path.join(__dirname, 'data.json');

// ========== DB ==========
const defaultData = {
  dailySold: 0,
  dailyDate: new Date().toISOString().slice(0, 10),
  orders: {},
  shopMessageId: null,
  nextDeliveryIndex: 0,
};

function loadData() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      return { ...defaultData, ...JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('DB load:', e.message);
  }
  return { ...defaultData };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('DB save:', e.message);
  }
}

let data = loadData();

function ensureDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (data.dailyDate !== today) {
    data.dailySold = 0;
    data.dailyDate = today;
    data.nextDeliveryIndex = 0;
    saveData();
  }
}

function getAvailable() {
  ensureDailyReset();
  return Math.max(0, config.dailyLimit - data.dailySold);
}

function getPendingCount() {
  return Object.values(data.orders).filter(
    (o) => o.status === 'pending_payment' || o.status === 'awaiting_confirmation'
  ).length;
}

function createOrder(userId, quantity, price) {
  ensureDailyReset();
  const id = randomUUID();
  data.orders[id] = {
    id,
    userId: String(userId),
    quantity,
    price,
    status: 'pending_payment',
    paypayLink: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.paymentTimeoutSeconds * 1000,
  };
  saveData();
  return data.orders[id];
}

function getOrder(id) {
  return data.orders[id] || null;
}

function updateOrder(id, updates) {
  if (!data.orders[id]) return null;
  Object.assign(data.orders[id], updates);
  saveData();
  return data.orders[id];
}

function findAwaitingByAmount(amount) {
  return (
    Object.values(data.orders)
      .filter((o) => o.status === 'awaiting_confirmation' && Number(o.price) === Number(amount))
      .sort((a, b) => a.createdAt - b.createdAt)[0] || null
  );
}

function pickDeliveryToken() {
  if (!config.deliveryUserTokens.length) return null;
  const i = data.nextDeliveryIndex % config.deliveryUserTokens.length;
  data.nextDeliveryIndex = (data.nextDeliveryIndex + 1) % config.deliveryUserTokens.length;
  saveData();
  return config.deliveryUserTokens[i];
}

// ========== ユーティリティ ==========
function formatNumber(n) {
  return Number(n).toLocaleString('ja-JP');
}

function calcPrice(quantity) {
  return Math.ceil((Number(quantity) / 100000) * config.pricePer100k);
}

function parseQuantity(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase().replace(/,/g, '').replace(/　/g, '');
  if (s.endsWith('万')) {
    const n = parseFloat(s.slice(0, -1));
    return isNaN(n) ? null : Math.floor(n * 10000);
  }
  if (s.endsWith('m')) {
    const n = parseFloat(s.slice(0, -1));
    return isNaN(n) ? null : Math.floor(n * 1000000);
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function isAdmin(userId) {
  return config.adminIds.includes(String(userId));
}

function isValidPayPayUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  // 形式チェック
  if (!/^https?:\/\/(qr\.paypay\.ne\.jp|pay\.paypay\.ne\.jp|www\.paypay\.ne\.jp)\//i.test(u)) {
    return false;
  }
  // 明らかに短すぎる・ゴミを弾く
  if (u.length < 25) return false;
  return true;
}

/** PayPayリンク先を簡易チェック（切れてる・金額不一致を弾く） */
function checkPayPayLink(url, expectedYen) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'タイムアウト（リンク確認不可）' }), 8000);

    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
          timeout: 7000,
        },
        (res) => {
          // リダイレクト
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            checkPayPayLink(res.headers.location, expectedYen).then(finish);
            return;
          }
          if (res.statusCode === 404 || res.statusCode === 410) {
            clearTimeout(timer);
            finish({ ok: false, reason: 'リンクが無効または期限切れです' });
            return;
          }
          let body = '';
          res.on('data', (c) => {
            body += c;
            if (body.length > 200000) res.destroy();
          });
          res.on('end', () => {
            clearTimeout(timer);
            const text = body.replace(/\s+/g, ' ');

            // 期限切れ・エラー文言
            if (
              /期限切れ|無効|存在しません|expired|not found|エラー|このリンクは使用できません|受け取り済み/i.test(
                text
              )
            ) {
              finish({ ok: false, reason: 'リンクが無効・期限切れ・受け取り済みの可能性があります' });
              return;
            }

            // 金額らしき数字を探す（円）
            const yenMatches = [...text.matchAll(/(\d{1,3}(?:,\d{3})*|\d+)\s*円/g)].map((m) =>
              parseInt(String(m[1]).replace(/,/g, ''), 10)
            );
            const unique = [...new Set(yenMatches.filter((n) => n > 0 && n < 10000000))];

            if (unique.length === 0) {
              // 金額がページから取れない場合は「形式OK・中身不明」→ 管理者確認待ちにするか、厳しく弾くか
              // ここでは厳しめに「確認できない」として弾く（Automate金額一致で救済）
              finish({ ok: false, reason: 'リンクから金額を確認できませんでした（切れ・非公開の可能性）' });
              return;
            }

            if (!unique.includes(Number(expectedYen))) {
              finish({
                ok: false,
                reason: `金額が一致しません（リンク側: ${unique.join(',')}円 / 注文: ${expectedYen}円）`,
              });
              return;
            }

            finish({ ok: true, detectedAmounts: unique });
          });
        }
      );
      req.on('error', () => {
        clearTimeout(timer);
        finish({ ok: false, reason: 'リンクに接続できませんでした' });
      });
      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timer);
        finish({ ok: false, reason: 'タイムアウト' });
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, reason: e.message });
    }
  });
}

function sendAsUser(token, channelId, content) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: content });
    const apiPath = '/api/v9/channels/' + String(channelId) + '/messages';
    const req = https.request(
      {
        hostname: 'discord.com',
        path: apiPath,
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      function (res) {
        let d = '';
        res.on('data', function (c) { d += c; });
        res.on('end', function () {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else {
            console.error('sendAsUser fail', res.statusCode, d.slice(0, 200));
            resolve(false);
          }
        });
      }
    );
    req.on('error', function (e) {
      console.error('sendAsUser error', e.message);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ========== Discord ==========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

function buildShopPayload() {
  ensureDailyReset();
  const available = getAvailable();
  const pending = getPendingCount();

  const embed = new EmbedBuilder()
    .setTitle('OwO Cowoncy 自販機')
    .setDescription(
      '下のボタンから購入数量を入力してください。\n送信先は購入者本人に固定されます。'
    )
    .addFields(
      {
        name: '本日販売枠',
        value: `${formatNumber(config.dailyLimit)} (${(config.dailyLimit / 1e6).toFixed(2)}M)`,
        inline: true,
      },
      {
        name: '現在購入可能',
        value: `${formatNumber(available)} (${(available / 1e6).toFixed(2)}M)`,
        inline: true,
      },
      { name: '送金確認保留', value: String(pending), inline: true },
      { name: '入金確認待ち', value: String(pending), inline: true },
      { name: '価格', value: `${config.pricePer100k}円 / 10万`, inline: true },
      { name: '最低購入量', value: formatNumber(config.minPurchase), inline: true },
      { name: '購入単位', value: `${formatNumber(config.purchaseUnit)}刻み`, inline: true },
      {
        name: '入力例',
        value: '`100万` / `1m` / `1000000` / `1,000,000`',
        inline: false,
      }
    )
    .setColor(0x5865f2)
    .setFooter({ text: '入金確認後、自動で配送されます' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy').setLabel('購入').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

async function updateShopMessage() {
  if (!config.shopChannelId) return;
  try {
    const ch = await client.channels.fetch(config.shopChannelId);
    if (!ch?.isTextBased()) return;
    const payload = buildShopPayload();
    if (data.shopMessageId) {
      try {
        const msg = await ch.messages.fetch(data.shopMessageId);
        await msg.edit(payload);
        return;
      } catch (_) {}
    }
    const sent = await ch.send(payload);
    data.shopMessageId = sent.id;
    saveData();
  } catch (e) {
    console.error('updateShopMessage', e.message);
  }
}

async function postHistory(userId, quantity) {
  if (!config.historyChannelId) return;
  try {
    const ch = await client.channels.fetch(config.historyChannelId);
    if (!ch?.isTextBased()) return;
    await ch.send(`<@${userId}> ${formatNumber(quantity)}万 送信済み ✅`.replace('万万', '万'));
    // quantity は生の数値（例 2000000）なので表示は万単位に
  } catch (e) {
    console.error('history', e.message);
  }
}

async function postHistoryCorrect(userId, quantity) {
  if (!config.historyChannelId) return;
  try {
    const ch = await client.channels.fetch(config.historyChannelId);
    if (!ch?.isTextBased()) return;
    const man = Math.floor(Number(quantity) / 10000);
    await ch.send(`<@${userId}> ${formatNumber(man)}万 送信済み ✅`);
  } catch (e) {
    console.error('history', e.message);
  }
}

async function deliverOrder(orderId, source = 'auto') {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: '注文なし' };
  if (order.status === 'delivered') return { ok: false, error: '配送済み' };
  if (['cancelled', 'expired'].includes(order.status)) {
    return { ok: false, error: 'キャンセル/期限切れ' };
  }

  ensureDailyReset();
  data.dailySold += order.quantity;
  updateOrder(orderId, { status: 'paid', paidAt: Date.now() });

  let owoOk = false;
  const token = pickDeliveryToken();
  if (token && config.deliveryChannelId) {
    const content = `owo give <@${order.userId}> ${order.quantity}`;
    owoOk = await sendAsUser(token, config.deliveryChannelId, content);
  }

  updateOrder(orderId, { status: 'delivered', deliveredAt: Date.now(), owoSent: owoOk });

  try {
    const user = await client.users.fetch(order.userId);
    const embed = new EmbedBuilder()
      .setTitle('OwOの配送が完了しました')
      .setColor(0x57f287)
      .addFields(
        { name: '注文', value: `\`${orderId}\`` },
        { name: '配送量', value: `${formatNumber(order.quantity)} Cowoncy` }
      )
      .setFooter({ text: source === 'auto' ? '自動入金確認により配送' : '管理者確認により配送' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
  } catch (e) {
    console.error('DM', e.message);
  }

  await postHistoryCorrect(order.userId, order.quantity);

  for (const adminId of config.adminIds) {
    try {
      const admin = await client.users.fetch(adminId);
      await admin.send(
        `【配送完了/${source}】\n注文:\`${orderId}\`\n購入者:<@${order.userId}>\n数量:${formatNumber(order.quantity)}\nowo:${owoOk ? '成功' : '失敗または未設定'}`
      );
    } catch (_) {}
  }

  await updateShopMessage();
  console.log(`[${source}] delivered ${orderId} qty=${order.quantity} owo=${owoOk}`);
  return { ok: true, order, owoOk };
}

function onReady() {
  console.log(`Botが正常に起動しました: ${client.user.tag}`);
  ensureDailyReset();
  updateShopMessage();
  setInterval(() => {
    const now = Date.now();
    for (const o of Object.values(data.orders)) {
      if (o.status === 'pending_payment' && o.expiresAt < now) {
        updateOrder(o.id, { status: 'expired' });
        console.log('expired', o.id);
      }
    }
  }, 15000);
}

client.once('clientReady', onReady);
client.once('ready', onReady);

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'buy') return handleBuy(interaction);
      if (interaction.customId.startsWith('pay_')) return handlePayBtn(interaction);
      if (interaction.customId.startsWith('admin_confirm_')) return handleAdminConfirm(interaction);
      if (interaction.customId.startsWith('admin_cancel_')) return handleAdminCancel(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'quantity_modal') return handleQtyModal(interaction);
      if (interaction.customId.startsWith('paypay_modal_')) return handlePayPayModal(interaction);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: 'エラーが発生しました。もう一度お試しください。', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

async function handleBuy(interaction) {
  if (getAvailable() < config.minPurchase) {
    return interaction.reply({ content: '現在購入可能な在庫がありません。', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('quantity_modal').setTitle('購入数量を入力');
  const input = new TextInputBuilder()
    .setCustomId('quantity')
    .setLabel(`数量（最低${formatNumber(config.minPurchase)} / ${formatNumber(config.purchaseUnit)}刻み）`)
    .setPlaceholder('例: 100万 または 1000000')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleQtyModal(interaction) {
  const quantity = parseQuantity(interaction.fields.getTextInputValue('quantity'));
  if (!quantity || quantity < config.minPurchase) {
    return interaction.reply({
      content: `最低購入量は ${formatNumber(config.minPurchase)} です。`,
      ephemeral: true,
    });
  }
  if (quantity % config.purchaseUnit !== 0) {
    return interaction.reply({
      content: `購入単位は ${formatNumber(config.purchaseUnit)} 刻みです。`,
      ephemeral: true,
    });
  }
  if (quantity > getAvailable()) {
    return interaction.reply({
      content: `購入可能数超過。現在: ${formatNumber(getAvailable())}`,
      ephemeral: true,
    });
  }

  const price = calcPrice(quantity);
  const order = createOrder(interaction.user.id, quantity, price);

  const embed = new EmbedBuilder()
    .setTitle('購入内容を確保しました')
    .setColor(0x57f287)
    .addFields(
      { name: '注文ID', value: `\`${order.id}\`` },
      { name: '送信先', value: `<@${interaction.user.id}>（購入者本人）` },
      { name: '数量', value: `${formatNumber(quantity)} (${(quantity / 1e6).toFixed(1)}M)` },
      { name: '支払額', value: `**${price}円**` }
    )
    .setDescription(
      `**${config.paymentTimeoutSeconds / 60}分以内に支払いを完了してください。**\n` +
        `下の「支払う」からPayPay送金リンクを入力してください。\n` +
        `時間を過ぎた場合は購入内容を戻すので、購入ボタンからもう一度選び直してください。`
    )
    .setFooter({ text: 'これはあなただけに表示されています' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pay_${order.id}`).setLabel('支払う').setStyle(ButtonStyle.Success)
  );
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  await updateShopMessage();
}

async function handlePayBtn(interaction) {
  const orderId = interaction.customId.replace('pay_', '');
  const order = getOrder(orderId);
  if (!order || order.userId !== interaction.user.id) {
    return interaction.reply({ content: '注文が見つかりません。', ephemeral: true });
  }
  if (order.status !== 'pending_payment') {
    return interaction.reply({ content: `処理済み（${order.status}）`, ephemeral: true });
  }
  if (order.expiresAt < Date.now()) {
    updateOrder(orderId, { status: 'expired' });
    return interaction.reply({ content: '支払い期限切れです。', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`paypay_modal_${orderId}`).setTitle('PayPay送金リンクを入力');
  const input = new TextInputBuilder()
    .setCustomId('paypay_link')
    .setLabel('PayPayの送金リンク（共有文可）')
    .setPlaceholder('https://qr.paypay.ne.jp/...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handlePayPayModal(interaction) {
  const orderId = interaction.customId.replace('paypay_modal_', '');
  const order = getOrder(orderId);
  if (!order || order.userId !== interaction.user.id) {
    return interaction.reply({ content: '注文が見つかりません。', ephemeral: true });
  }
  if (order.status !== 'pending_payment') {
    return interaction.reply({ content: '処理済みです。', ephemeral: true });
  }
  if (order.expiresAt < Date.now()) {
    updateOrder(orderId, { status: 'expired' });
    return interaction.reply({ content: '支払い期限切れです。', ephemeral: true });
  }

  let raw = interaction.fields.getTextInputValue('paypay_link').trim();
  // 共有文からURLだけ抜く
  const urlMatch = raw.match(/https?:\/\/(?:qr|pay|www)\.paypay\.ne\.jp\/[^\s<>"']+/i);
  const link = urlMatch ? urlMatch[0] : raw;

  if (!isValidPayPayUrl(link)) {
    return interaction.reply({
      content:
        '❌ 有効なPayPayリンクではありません。\n`https://qr.paypay.ne.jp/...` の形式で正しいリンクを入力してください。',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // リンク切れ・金額不一致チェック
  const check = await checkPayPayLink(link, order.price);
  if (!check.ok) {
    return interaction.editReply({
      content: `❌ このPayPayリンクは使えません。\n理由: ${check.reason}\n\n正しい金額（**${order.price}円**）の有効なリンクを、もう一度「支払う」から送り直してください。`,
    });
  }

  updateOrder(orderId, { paypayLink: link, status: 'awaiting_confirmation' });

  await interaction.editReply({
    content:
      '✅ PayPayリンクを受け付けました。\n入金が確認でき次第、自動で配送します。しばらくお待ちください。',
  });

  const adminEmbed = new EmbedBuilder()
    .setTitle('【入金確認待ち】')
    .setColor(0xfee75c)
    .addFields(
      { name: '注文ID', value: `\`${orderId}\`` },
      { name: '購入者', value: `<@${order.userId}>` },
      { name: '数量', value: formatNumber(order.quantity) },
      { name: '支払額', value: `**${order.price}円**` },
      { name: 'PayPayリンク', value: link },
      { name: 'リンクチェック', value: '金額一致を確認済み' }
    )
    .setTimestamp();

  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_confirm_${orderId}`)
      .setLabel('入金確認済み → 配送')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`admin_cancel_${orderId}`)
      .setLabel('キャンセル')
      .setStyle(ButtonStyle.Danger)
  );

  for (const adminId of config.adminIds) {
    try {
      const admin = await client.users.fetch(adminId);
      await admin.send({ embeds: [adminEmbed], components: [adminRow] });
    } catch (_) {}
  }
  await updateShopMessage();
}

async function handleAdminConfirm(interaction) {
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({ content: '権限がありません。', ephemeral: true });
  }
  const orderId = interaction.customId.replace('admin_confirm_', '');
  const result = await deliverOrder(orderId, 'manual');
  if (!result.ok) {
    return interaction.reply({ content: result.error, ephemeral: true });
  }
  await interaction.update({
    content: `✅ 配送完了 \`${orderId}\` / owo: ${result.owoOk ? '成功' : '失敗または未設定'}`,
    embeds: [],
    components: [],
  });
}

async function handleAdminCancel(interaction) {
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({ content: '権限がありません。', ephemeral: true });
  }
  const orderId = interaction.customId.replace('admin_cancel_', '');
  updateOrder(orderId, { status: 'cancelled' });
  await interaction.update({
    content: `❌ キャンセル \`${orderId}\``,
    embeds: [],
    components: [],
  });
  await updateShopMessage();
}

// ========== Webhook (Automate) ==========
function startServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'ok', bot: config.botName }));
    }
    if (req.method === 'POST' && req.url === '/confirm-payment') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const json = JSON.parse(body || '{}');
          const secret = json.secret || req.headers['x-webhook-secret'];
          const amount = Number(json.amount);
          if (secret !== config.webhookSecret) {
            res.writeHead(401);
            return res.end(JSON.stringify({ ok: false, error: 'invalid secret' }));
          }
          if (!amount || amount <= 0) {
            res.writeHead(400);
            return res.end(JSON.stringify({ ok: false, error: 'amount required' }));
          }
          const order = findAwaitingByAmount(amount);
          if (!order) {
            res.writeHead(404);
            console.log('[auto] no order for', amount);
            return res.end(JSON.stringify({ ok: false, error: 'no matching order', amount }));
          }
          const result = await deliverOrder(order.id, 'auto');
          res.writeHead(result.ok ? 200 : 400);
          res.end(
            JSON.stringify({
              ok: result.ok,
              orderId: order.id,
              quantity: order.quantity,
              price: order.price,
              owoOk: result.owoOk,
            })
          );
        } catch (e) {
          console.error('webhook', e);
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: 'server error' }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Keep-alive / Webhook on port ${PORT}`);
    console.log(`POST /confirm-payment {"secret":"...","amount":120}`);
  });
}

if (!config.token) {
  console.error('DISCORD_TOKEN がありません');
  process.exit(1);
}

client
  .login(config.token)
  .then(() => startServer())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
