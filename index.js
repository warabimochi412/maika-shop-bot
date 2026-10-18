const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
require('dotenv').config();

const config = {
  token: process.env.DISCORD_TOKEN || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  shopChannelId: process.env.SHOP_CHANNEL_ID || '',
  historyChannelId: process.env.HISTORY_CHANNEL_ID || '',
  deliveryUserTokens: (process.env.DELIVERY_USER_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean),
  deliveryChannelId: process.env.DELIVERY_CHANNEL_ID || '',
  pricePer100k: Number(process.env.PRICE_PER_100K) || 10,
  minPurchase: Number(process.env.MIN_PURCHASE) || 10000,
  purchaseUnit: Number(process.env.PURCHASE_UNIT) || 10000,
  dailyLimit: Number(process.env.DAILY_LIMIT) || 100000000,
  paymentTimeoutSeconds: Number(process.env.PAYMENT_TIMEOUT_SECONDS) || 120,
  webhookSecret: process.env.WEBHOOK_SECRET || 'change-me',
};

const PORT = Number(process.env.PORT) || 8080;
const DATA_PATH = path.join(__dirname, 'data.json');

let data = { dailySold: 0, dailyDate: new Date().toISOString().slice(0, 10), orders: {}, shopMessageId: null, nextDeliveryIndex: 0 };
try {
  if (fs.existsSync(DATA_PATH)) data = Object.assign(data, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
} catch (e) { console.error(e.message); }

function save() {
  try { fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2)); } catch (e) { console.error(e.message); }
}

function ensureDay() {
  const t = new Date().toISOString().slice(0, 10);
  if (data.dailyDate !== t) { data.dailySold = 0; data.dailyDate = t; data.nextDeliveryIndex = 0; save(); }
}

function available() { ensureDay(); return Math.max(0, config.dailyLimit - data.dailySold); }
function pendingCount() {
  return Object.values(data.orders).filter(o => o.status === 'pending_payment' || o.status === 'awaiting_confirmation').length;
}
function fmt(n) { return Number(n).toLocaleString('ja-JP'); }
function priceOf(q) { return Math.ceil((Number(q) / 100000) * config.pricePer100k); }
function isAdmin(id) { return config.adminIds.includes(String(id)); }

function parseQty(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase().replace(/,/g, '').replace(/　/g, '');
  if (s.endsWith('万')) { const n = parseFloat(s.slice(0, -1)); return isNaN(n) ? null : Math.floor(n * 10000); }
  if (s.endsWith('m')) { const n = parseFloat(s.slice(0, -1)); return isNaN(n) ? null : Math.floor(n * 1000000); }
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function extractPayPayUrl(text) {
  const m = String(text).match(/https?:\/\/(?:qr|pay|www)\.paypay\.ne\.jp\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

function pickToken() {
  if (!config.deliveryUserTokens.length) return null;
  const i = data.nextDeliveryIndex % config.deliveryUserTokens.length;
  data.nextDeliveryIndex = (data.nextDeliveryIndex + 1) % config.deliveryUserTokens.length;
  save();
  return config.deliveryUserTokens[i];
}

function sendAsUser(token, channelId, content) {
  return new Promise(resolve => {
    const body = JSON.stringify({ content: content });
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v9/channels/' + String(channelId) + '/messages',
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

function shopPayload() {
  ensureDay();
  const av = available();
  const pe = pendingCount();
  const embed = new EmbedBuilder()
    .setTitle('OwO Cowoncy 自販機')
    .setDescription('下のボタンから購入数量を入力してください。\n送信先は購入者本人に固定されます。')
    .addFields(
      { name: '本日販売枠', value: fmt(config.dailyLimit) + ' (' + (config.dailyLimit / 1e6).toFixed(2) + 'M)', inline: true },
      { name: '現在購入可能', value: fmt(av) + ' (' + (av / 1e6).toFixed(2) + 'M)', inline: true },
      { name: '送金確認保留', value: String(pe), inline: true },
      { name: '入金確認待ち', value: String(pe), inline: true },
      { name: '価格', value: config.pricePer100k + '円 / 10万', inline: true },
      { name: '最低購入量', value: fmt(config.minPurchase), inline: true },
      { name: '購入単位', value: fmt(config.purchaseUnit) + '刻み', inline: true },
      { name: '入力例', value: '100万 / 1m / 1000000', inline: false }
    )
    .setColor(0x5865f2)
    .setFooter({ text: '入金確認後、自動で配送されます' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy').setLabel('購入').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

async function updateShop() {
  if (!config.shopChannelId) return;
  try {
    const ch = await client.channels.fetch(config.shopChannelId);
    if (!ch || !ch.isTextBased()) return;
    const payload = shopPayload();
    if (data.shopMessageId) {
      try {
        const msg = await ch.messages.fetch(data.shopMessageId);
        await msg.edit(payload);
        return;
      } catch (e) {}
    }
    const sent = await ch.send(payload);
    data.shopMessageId = sent.id;
    save();
  } catch (e) { console.error('updateShop', e.message); }
}

async function deliver(orderId, source) {
  const order = data.orders[orderId];
  if (!order) return { ok: false, error: '注文なし' };
  if (order.status === 'delivered') return { ok: false, error: '配送済み' };
  if (order.status === 'cancelled' || order.status === 'expired') return { ok: false, error: 'キャンセル済み' };

  ensureDay();
  data.dailySold += order.quantity;
  order.status = 'delivered';
  order.deliveredAt = Date.now();
  save();

  let owoOk = false;
  const token = pickToken();
  if (token && config.deliveryChannelId) {
    owoOk = await sendAsUser(token, config.deliveryChannelId, 'owo give <@' + order.userId + '> ' + order.quantity);
  }
  order.owoSent = owoOk;
  save();

  try {
    const user = await client.users.fetch(order.userId);
    const embed = new EmbedBuilder()
      .setTitle('OwOの配送が完了しました')
      .setColor(0x57f287)
      .addFields(
        { name: '注文', value: '`' + orderId + '`' },
        { name: '配送量', value: fmt(order.quantity) + ' Cowoncy' }
      )
      .setFooter({ text: source === 'auto' ? '自動入金確認により配送' : '管理者確認により配送' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
  } catch (e) {}

  if (config.historyChannelId) {
    try {
      const ch = await client.channels.fetch(config.historyChannelId);
      if (ch && ch.isTextBased()) {
        const man = Math.floor(order.quantity / 10000);
        await ch.send('<@' + order.userId + '> ' + fmt(man) + '万 送信済み ✅');
      }
    } catch (e) {}
  }

  for (const aid of config.adminIds) {
    try {
      const admin = await client.users.fetch(aid);
      await admin.send('【配送完了/' + source + '】\n注文:`' + orderId + '`\n購入者:<@' + order.userId + '>\n数量:' + fmt(order.quantity) + '\nowo:' + (owoOk ? '成功' : '失敗'));
    } catch (e) {}
  }

  await updateShop();
  console.log('[' + source + '] delivered ' + orderId + ' qty=' + order.quantity + ' owo=' + owoOk);
  return { ok: true, owoOk: owoOk };
}

function onReady() {
  console.log('Botが正常に起動しました: ' + client.user.tag);
  ensureDay();
  updateShop();
  setInterval(() => {
    const now = Date.now();
    for (const o of Object.values(data.orders)) {
      if (o.status === 'pending_payment' && o.expiresAt < now) {
        o.status = 'expired';
        save();
      }
    }
  }, 15000);
}

client.once('clientReady', onReady);
client.once('ready', onReady);

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === 'buy') {
      if (available() < config.minPurchase) {
        return interaction.reply({ content: '在庫がありません。', ephemeral: true });
      }
      const modal = new ModalBuilder().setCustomId('qty_modal').setTitle('購入数量を入力');
      const input = new TextInputBuilder()
        .setCustomId('qty')
        .setLabel('数量（最低' + fmt(config.minPurchase) + '）')
        .setPlaceholder('例: 100万 または 1000000')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'qty_modal') {
      const quantity = parseQty(interaction.fields.getTextInputValue('qty'));
      if (!quantity || quantity < config.minPurchase) {
        return interaction.reply({ content: '最低購入量は ' + fmt(config.minPurchase) + ' です。', ephemeral: true });
      }
      if (quantity % config.purchaseUnit !== 0) {
        return interaction.reply({ content: '購入単位は ' + fmt(config.purchaseUnit) + ' 刻みです。', ephemeral: true });
      }
      if (quantity > available()) {
        return interaction.reply({ content: '購入可能数超過。現在: ' + fmt(available()), ephemeral: true });
      }
      const price = priceOf(quantity);
      const id = randomUUID();
      data.orders[id] = {
        id: id,
        userId: String(interaction.user.id),
        quantity: quantity,
        price: price,
        status: 'pending_payment',
        paypayLink: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + config.paymentTimeoutSeconds * 1000
      };
      save();

      const embed = new EmbedBuilder()
        .setTitle('購入内容を確保しました')
        .setColor(0x57f287)
        .addFields(
          { name: '注文ID', value: '`' + id + '`' },
          { name: '送信先', value: '<@' + interaction.user.id + '>（購入者本人）' },
          { name: '数量', value: fmt(quantity) + ' (' + (quantity / 1e6).toFixed(1) + 'M)' },
          { name: '支払額', value: '**' + price + '円**' }
        )
        .setDescription('**' + (config.paymentTimeoutSeconds / 60) + '分以内に支払いを完了してください。**\n下の「支払う」からPayPay送金リンクを入力してください。\n時間を過ぎた場合は購入ボタンからやり直してください。')
        .setFooter({ text: 'これはあなただけに表示されています' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pay_' + id).setLabel('支払う').setStyle(ButtonStyle.Success)
      );
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      await updateShop();
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('pay_')) {
      const orderId = interaction.customId.slice(4);
      const order = data.orders[orderId];
      if (!order || order.userId !== String(interaction.user.id)) {
        return interaction.reply({ content: '注文が見つかりません。', ephemeral: true });
      }
      if (order.status !== 'pending_payment') {
        return interaction.reply({ content: '処理済みです。', ephemeral: true });
      }
      if (order.expiresAt < Date.now()) {
        order.status = 'expired';
        save();
        return interaction.reply({ content: '支払い期限切れです。', ephemeral: true });
      }
      const modal = new ModalBuilder().setCustomId('pp_' + orderId).setTitle('PayPay送金リンクを入力');
      const input = new TextInputBuilder()
        .setCustomId('link')
        .setLabel('PayPayリンク（共有文可）')
        .setPlaceholder('https://qr.paypay.ne.jp/...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('pp_')) {
      const orderId = interaction.customId.slice(3);
      const order = data.orders[orderId];
      if (!order || order.userId !== String(interaction.user.id)) {
        return interaction.reply({ content: '注文が見つかりません。', ephemeral: true });
      }
      if (order.status !== 'pending_payment') {
        return interaction.reply({ content: '処理済みです。', ephemeral: true });
      }
      if (order.expiresAt < Date.now()) {
        order.status = 'expired';
        save();
        return interaction.reply({ content: '支払い期限切れです。', ephemeral: true });
      }

      const raw = interaction.fields.getTextInputValue('link');
      const link = extractPayPayUrl(raw);
      if (!link) {
        return interaction.reply({
          content: '❌ 有効なPayPayリンクではありません。\nhttps://qr.paypay.ne.jp/... の形式で入力してください。',
          ephemeral: true
        });
      }

      order.paypayLink = link;
      order.status = 'awaiting_confirmation';
      save();

      await interaction.reply({
        content: '✅ PayPayリンクを受け付けました。\n入金確認後、自動で配送します。',
        ephemeral: true
      });

      const adminEmbed = new EmbedBuilder()
        .setTitle('【入金確認待ち】')
        .setColor(0xfee75c)
        .addFields(
          { name: '注文ID', value: '`' + orderId + '`' },
          { name: '購入者', value: '<@' + order.userId + '>' },
          { name: '数量', value: fmt(order.quantity) },
          { name: '支払額', value: '**' + order.price + '円**' },
          { name: 'PayPayリンク', value: link }
        )
        .setTimestamp();
      const adminRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ok_' + orderId).setLabel('入金確認済み → 配送').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ng_' + orderId).setLabel('キャンセル').setStyle(ButtonStyle.Danger)
      );
      for (const aid of config.adminIds) {
        try {
          const admin = await client.users.fetch(aid);
          await admin.send({ embeds: [adminEmbed], components: [adminRow] });
        } catch (e) {}
      }
      await updateShop();
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ok_')) {
      if (!isAdmin(interaction.user.id)) {
        return interaction.reply({ content: '権限がありません。', ephemeral: true });
      }
      const orderId = interaction.customId.slice(3);
      const result = await deliver(orderId, 'manual');
      if (!result.ok) return interaction.reply({ content: result.error, ephemeral: true });
      return interaction.update({ content: '✅ 配送完了 `' + orderId + '` / owo:' + (result.owoOk ? '成功' : '失敗'), embeds: [], components: [] });
    }

    if (interaction.isButton() && interaction.customId.startsWith('ng_')) {
      if (!isAdmin(interaction.user.id)) {
        return interaction.reply({ content: '権限がありません。', ephemeral: true });
      }
      const orderId = interaction.customId.slice(3);
      if (data.orders[orderId]) {
        data.orders[orderId].status = 'cancelled';
        save();
      }
      await updateShop();
      return interaction.update({ content: '❌ キャンセル `' + orderId + '`', embeds: [], components: [] });
    }
  } catch (err) {
    console.error(err);
    const msg = { content: 'エラーが発生しました。', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (req.method === 'POST' && req.url === '/confirm-payment') {
      let body = '';
      req.on('data', c => body += c);
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
          const order = Object.values(data.orders)
            .filter(o => o.status === 'awaiting_confirmation' && Number(o.price) === amount)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (!order) {
            res.writeHead(404);
            return res.end(JSON.stringify({ ok: false, error: 'no matching order', amount: amount }));
          }
          const result = await deliver(order.id, 'auto');
          res.writeHead(result.ok ? 200 : 400);
          res.end(JSON.stringify({ ok: result.ok, orderId: order.id, quantity: order.quantity, price: order.price, owoOk: result.owoOk }));
        } catch (e) {
          console.error(e);
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Keep-alive / Webhook on port ' + PORT);
  });
}

if (!config.token) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

client.login(config.token).then(() => startServer()).catch(e => {
  console.error(e);
  process.exit(1);
});
