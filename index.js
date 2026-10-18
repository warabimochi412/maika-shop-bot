/**
 * maika雋ｩ螢ｲ謇 - 蛻ｺ霄ｫ鬚ｨ OwO Cowoncy 閾ｪ雋ｩ讖檻ot
 * 繧ｳ繝斐�逕ｨ繝ｻ1繝輔ぃ繧､繝ｫ螳檎ｵ�
 *
 * 蠢�ｦ√ヱ繝�こ繝ｼ繧ｸ: discord.js dotenv
 * 襍ｷ蜍�: node index.js
 *
 * 縲先ｳｨ諢上船ELIVERY_USER_TOKENS 縺ｫ繧医ｋ owo give 縺ｯ
 * Discord蛻ｩ逕ｨ隕冗ｴ�＆蜿搾ｼ医そ繝ｫ繝輔�繝�ヨ�峨→縺ｪ繧械AN繝ｪ繧ｹ繧ｯ縺後≠繧翫∪縺吶り�蟾ｱ雋ｬ莉ｻ縺ｧ縲�
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

// ========== 險ｭ螳夲ｼ育腸蠅�､画焚�� ==========
const config = {
  token: process.env.DISCORD_TOKEN || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  shopChannelId: process.env.SHOP_CHANNEL_ID || '',
  historyChannelId: process.env.HISTORY_CHANNEL_ID || '', // 騾∽ｿ｡螻･豁ｴ繝√Ε繝ｳ繝阪Ν�井ｻｻ諢擾ｼ�
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
  botName: 'maika雋ｩ螢ｲ謇',
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

// ========== 繝ｦ繝ｼ繝�ぅ繝ｪ繝�ぅ ==========
function formatNumber(n) {
  return Number(n).toLocaleString('ja-JP');
}

function calcPrice(quantity) {
  return Math.ceil((Number(quantity) / 100000) * config.pricePer100k);
}

function parseQuantity(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase().replace(/,/g, '').replace(/縲/g, '');
  if (s.endsWith('荳�')) {
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
  // 蠖｢蠑上メ繧ｧ繝�け
  if (!/^https?:\/\/(qr\.paypay\.ne\.jp|pay\.paypay\.ne\.jp|www\.paypay\.ne\.jp)\//i.test(u)) {
    return false;
  }
  // 譏弱ｉ縺九↓遏ｭ縺吶℃繧九�繧ｴ繝溘ｒ蠑ｾ縺�
  if (u.length < 25) return false;
  return true;
}

/** PayPay繝ｪ繝ｳ繧ｯ蜈医ｒ邁｡譏薙メ繧ｧ繝�け�亥�繧後※繧九�驥鷹｡堺ｸ堺ｸ閾ｴ繧貞ｼｾ縺擾ｼ� */
function checkPayPayLink(url, expectedYen) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: '繧ｿ繧､繝�繧｢繧ｦ繝茨ｼ医Μ繝ｳ繧ｯ遒ｺ隱堺ｸ榊庄��' }), 8000);

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
          // 繝ｪ繝繧､繝ｬ繧ｯ繝�
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            checkPayPayLink(res.headers.location, expectedYen).then(finish);
            return;
          }
          if (res.statusCode === 404 || res.statusCode === 410) {
            clearTimeout(timer);
            finish({ ok: false, reason: '繝ｪ繝ｳ繧ｯ縺檎┌蜉ｹ縺ｾ縺溘�譛滄剞蛻�ｌ縺ｧ縺�' });
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

            // 譛滄剞蛻�ｌ繝ｻ繧ｨ繝ｩ繝ｼ譁�ｨ
            if (
              /譛滄剞蛻�ｌ|辟｡蜉ｹ|蟄伜惠縺励∪縺帙ｓ|expired|not found|繧ｨ繝ｩ繝ｼ|縺薙�繝ｪ繝ｳ繧ｯ縺ｯ菴ｿ逕ｨ縺ｧ縺阪∪縺帙ｓ|蜿励￠蜿悶ｊ貂医∩/i.test(
                text
              )
            ) {
              finish({ ok: false, reason: '繝ｪ繝ｳ繧ｯ縺檎┌蜉ｹ繝ｻ譛滄剞蛻�ｌ繝ｻ蜿励￠蜿悶ｊ貂医∩縺ｮ蜿ｯ閭ｽ諤ｧ縺後≠繧翫∪縺�' });
              return;
            }

            // 驥鷹｡阪ｉ縺励″謨ｰ蟄励ｒ謗｢縺呻ｼ亥���
            const yenMatches = [...text.matchAll(/(\d{1,3}(?:,\d{3})*|\d+)\s*蜀�/g)].map((m) =>
              parseInt(String(m[1]).replace(/,/g, ''), 10)
            );
            const unique = [...new Set(yenMatches.filter((n) => n > 0 && n < 10000000))];

            if (unique.length === 0) {
              // 驥鷹｡阪′繝壹�繧ｸ縺九ｉ蜿悶ｌ縺ｪ縺��ｴ蜷医�縲悟ｽ｢蠑衆K繝ｻ荳ｭ霄ｫ荳肴�縲坂� 邂｡逅��｢ｺ隱榊ｾ�■縺ｫ縺吶ｋ縺九∝宍縺励￥蠑ｾ縺上°
              // 縺薙％縺ｧ縺ｯ蜴ｳ縺励ａ縺ｫ縲檎｢ｺ隱阪〒縺阪↑縺�阪→縺励※蠑ｾ縺擾ｼ�Automate驥鷹｡堺ｸ閾ｴ縺ｧ謨第ｸ茨ｼ�
              finish({ ok: false, reason: '繝ｪ繝ｳ繧ｯ縺九ｉ驥鷹｡阪ｒ遒ｺ隱阪〒縺阪∪縺帙ｓ縺ｧ縺励◆�亥�繧後�髱槫�髢九�蜿ｯ閭ｽ諤ｧ��' });
              return;
            }

            if (!unique.includes(Number(expectedYen))) {
              finish({
                ok: false,
                reason: `驥鷹｡阪′荳閾ｴ縺励∪縺帙ｓ�医Μ繝ｳ繧ｯ蛛ｴ: ${unique.join(',')}蜀� / 豕ｨ譁�: ${expectedYen}蜀�ｼ荏,
              });
              return;
            }

            finish({ ok: true, detectedAmounts: unique });
          });
        }
      );
      req.on('error', () => {
        clearTimeout(timer);
        finish({ ok: false, reason: '繝ｪ繝ｳ繧ｯ縺ｫ謗･邯壹〒縺阪∪縺帙ｓ縺ｧ縺励◆' });
      });
      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timer);
        finish({ ok: false, reason: '繧ｿ繧､繝�繧｢繧ｦ繝�' });
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, reason: e.message });
    }
  });
}

function sendAsUser(token, channelId, content) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content });
    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v9/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else {
            console.error('sendAsUser fail', res.statusCode, d.slice(0, 200));
            resolve(false);
          }
        });
      }
    );
    req.on('error', (e) => {
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
    .setTitle('OwO Cowoncy 閾ｪ雋ｩ讖�')
    .setDescription(
      '荳九�繝懊ち繝ｳ縺九ｉ雉ｼ蜈･謨ｰ驥上ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞縲�\n騾∽ｿ｡蜈医�雉ｼ蜈･閠�悽莠ｺ縺ｫ蝗ｺ螳壹＆繧後∪縺吶�'
    )
    .addFields(
      {
        name: '譛ｬ譌･雋ｩ螢ｲ譫�',
        value: `${formatNumber(config.dailyLimit)} (${(config.dailyLimit / 1e6).toFixed(2)}M)`,
        inline: true,
      },
      {
        name: '迴ｾ蝨ｨ雉ｼ蜈･蜿ｯ閭ｽ',
        value: `${formatNumber(available)} (${(available / 1e6).toFixed(2)}M)`,
        inline: true,
      },
      { name: '騾�≡遒ｺ隱堺ｿ晉蕗', value: String(pending), inline: true },
      { name: '蜈･驥醍｢ｺ隱榊ｾ�■', value: String(pending), inline: true },
      { name: '萓｡譬ｼ', value: `${config.pricePer100k}蜀� / 10荳㌔, inline: true },
      { name: '譛菴手ｳｼ蜈･驥�', value: formatNumber(config.minPurchase), inline: true },
      { name: '雉ｼ蜈･蜊倅ｽ�', value: `${formatNumber(config.purchaseUnit)}蛻ｻ縺ｿ`, inline: true },
      {
        name: '蜈･蜉帑ｾ�',
        value: '`100荳㌔ / `1m` / `1000000` / `1,000,000`',
        inline: false,
      }
    )
    .setColor(0x5865f2)
    .setFooter({ text: '蜈･驥醍｢ｺ隱榊ｾ後∬�蜍輔〒驟埼√＆繧後∪縺�' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy').setLabel('雉ｼ蜈･').setStyle(ButtonStyle.Primary)
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
    await ch.send(`<@${userId}> ${formatNumber(quantity)}荳� 騾∽ｿ｡貂医∩ 笨�`.replace('荳�ｸ�', '荳�'));
    // quantity 縺ｯ逕溘�謨ｰ蛟､�井ｾ� 2000000�峨↑縺ｮ縺ｧ陦ｨ遉ｺ縺ｯ荳�腰菴阪↓
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
    await ch.send(`<@${userId}> ${formatNumber(man)}荳� 騾∽ｿ｡貂医∩ 笨�`);
  } catch (e) {
    console.error('history', e.message);
  }
}

async function deliverOrder(orderId, source = 'auto') {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: '豕ｨ譁�↑縺�' };
  if (order.status === 'delivered') return { ok: false, error: '驟埼∵ｸ医∩' };
  if (['cancelled', 'expired'].includes(order.status)) {
    return { ok: false, error: '繧ｭ繝｣繝ｳ繧ｻ繝ｫ/譛滄剞蛻�ｌ' };
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
      .setTitle('OwO縺ｮ驟埼√′螳御ｺ�＠縺ｾ縺励◆')
      .setColor(0x57f287)
      .addFields(
        { name: '豕ｨ譁�', value: `\`${orderId}\`` },
        { name: '驟埼�㍼', value: `${formatNumber(order.quantity)} Cowoncy` }
      )
      .setFooter({ text: source === 'auto' ? '閾ｪ蜍募�驥醍｢ｺ隱阪↓繧医ｊ驟埼�' : '邂｡逅��｢ｺ隱阪↓繧医ｊ驟埼�' })
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
        `縲宣�騾∝ｮ御ｺ�/${source}縲曾n豕ｨ譁�:\`${orderId}\`\n雉ｼ蜈･閠�:<@${order.userId}>\n謨ｰ驥�:${formatNumber(order.quantity)}\nowo:${owoOk ? '謌仙粥' : '螟ｱ謨励∪縺溘�譛ｪ險ｭ螳�'}`
      );
    } catch (_) {}
  }

  await updateShopMessage();
  console.log(`[${source}] delivered ${orderId} qty=${order.quantity} owo=${owoOk}`);
  return { ok: true, order, owoOk };
}

function onReady() {
  console.log(`Bot縺梧ｭ｣蟶ｸ縺ｫ襍ｷ蜍輔＠縺ｾ縺励◆: ${client.user.tag}`);
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
    const msg = { content: '繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆縲ゅｂ縺�ｸ蠎ｦ縺願ｩｦ縺励￥縺�縺輔＞縲�', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

async function handleBuy(interaction) {
  if (getAvailable() < config.minPurchase) {
    return interaction.reply({ content: '迴ｾ蝨ｨ雉ｼ蜈･蜿ｯ閭ｽ縺ｪ蝨ｨ蠎ｫ縺後≠繧翫∪縺帙ｓ縲�', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId('quantity_modal').setTitle('雉ｼ蜈･謨ｰ驥上ｒ蜈･蜉�');
  const input = new TextInputBuilder()
    .setCustomId('quantity')
    .setLabel(`謨ｰ驥擾ｼ域怙菴�${formatNumber(config.minPurchase)} / ${formatNumber(config.purchaseUnit)}蛻ｻ縺ｿ�荏)
    .setPlaceholder('萓�: 100荳� 縺ｾ縺溘� 1000000')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleQtyModal(interaction) {
  const quantity = parseQuantity(interaction.fields.getTextInputValue('quantity'));
  if (!quantity || quantity < config.minPurchase) {
    return interaction.reply({
      content: `譛菴手ｳｼ蜈･驥上� ${formatNumber(config.minPurchase)} 縺ｧ縺吶Ａ,
      ephemeral: true,
    });
  }
  if (quantity % config.purchaseUnit !== 0) {
    return interaction.reply({
      content: `雉ｼ蜈･蜊倅ｽ阪� ${formatNumber(config.purchaseUnit)} 蛻ｻ縺ｿ縺ｧ縺吶Ａ,
      ephemeral: true,
    });
  }
  if (quantity > getAvailable()) {
    return interaction.reply({
      content: `雉ｼ蜈･蜿ｯ閭ｽ謨ｰ雜�℃縲ら樟蝨ｨ: ${formatNumber(getAvailable())}`,
      ephemeral: true,
    });
  }

  const price = calcPrice(quantity);
  const order = createOrder(interaction.user.id, quantity, price);

  const embed = new EmbedBuilder()
    .setTitle('雉ｼ蜈･蜀�ｮｹ繧堤｢ｺ菫昴＠縺ｾ縺励◆')
    .setColor(0x57f287)
    .addFields(
      { name: '豕ｨ譁⑩D', value: `\`${order.id}\`` },
      { name: '騾∽ｿ｡蜈�', value: `<@${interaction.user.id}>�郁ｳｼ蜈･閠�悽莠ｺ�荏 },
      { name: '謨ｰ驥�', value: `${formatNumber(quantity)} (${(quantity / 1e6).toFixed(1)}M)` },
      { name: '謾ｯ謇暮｡�', value: `**${price}蜀�**` }
    )
    .setDescription(
      `**${config.paymentTimeoutSeconds / 60}蛻�ｻ･蜀�↓謾ｯ謇輔＞繧貞ｮ御ｺ�＠縺ｦ縺上□縺輔＞縲�**\n` +
        `荳九�縲梧髪謇輔≧縲阪°繧臼ayPay騾�≡繝ｪ繝ｳ繧ｯ繧貞�蜉帙＠縺ｦ縺上□縺輔＞縲�\n` +
        `譎る俣繧帝℃縺弱◆蝣ｴ蜷医�雉ｼ蜈･蜀�ｮｹ繧呈綾縺吶�縺ｧ縲∬ｳｼ蜈･繝懊ち繝ｳ縺九ｉ繧ゅ≧荳蠎ｦ驕ｸ縺ｳ逶ｴ縺励※縺上□縺輔＞縲Ａ
    )
    .setFooter({ text: '縺薙ｌ縺ｯ縺ゅ↑縺溘□縺代↓陦ｨ遉ｺ縺輔ｌ縺ｦ縺�∪縺�' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pay_${order.id}`).setLabel('謾ｯ謇輔≧').setStyle(ButtonStyle.Success)
  );
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  await updateShopMessage();
}

async function handlePayBtn(interaction) {
  const orderId = interaction.customId.replace('pay_', '');
  const order = getOrder(orderId);
  if (!order || order.userId !== interaction.user.id) {
    return interaction.reply({ content: '豕ｨ譁�′隕九▽縺九ｊ縺ｾ縺帙ｓ縲�', ephemeral: true });
  }
  if (order.status !== 'pending_payment') {
    return interaction.reply({ content: `蜃ｦ逅�ｸ医∩��${order.status}�荏, ephemeral: true });
  }
  if (order.expiresAt < Date.now()) {
    updateOrder(orderId, { status: 'expired' });
    return interaction.reply({ content: '謾ｯ謇輔＞譛滄剞蛻�ｌ縺ｧ縺吶�', ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`paypay_modal_${orderId}`).setTitle('PayPay騾�≡繝ｪ繝ｳ繧ｯ繧貞�蜉�');
  const input = new TextInputBuilder()
    .setCustomId('paypay_link')
    .setLabel('PayPay縺ｮ騾�≡繝ｪ繝ｳ繧ｯ�亥�譛画枚蜿ｯ��')
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
    return interaction.reply({ content: '豕ｨ譁�′隕九▽縺九ｊ縺ｾ縺帙ｓ縲�', ephemeral: true });
  }
  if (order.status !== 'pending_payment') {
    return interaction.reply({ content: '蜃ｦ逅�ｸ医∩縺ｧ縺吶�', ephemeral: true });
  }
  if (order.expiresAt < Date.now()) {
    updateOrder(orderId, { status: 'expired' });
    return interaction.reply({ content: '謾ｯ謇輔＞譛滄剞蛻�ｌ縺ｧ縺吶�', ephemeral: true });
  }

  let raw = interaction.fields.getTextInputValue('paypay_link').trim();
  // 蜈ｱ譛画枚縺九ｉURL縺�縺第栢縺�
  const urlMatch = raw.match(/https?:\/\/(?:qr|pay|www)\.paypay\.ne\.jp\/[^\s<>"']+/i);
  const link = urlMatch ? urlMatch[0] : raw;

  if (!isValidPayPayUrl(link)) {
    return interaction.reply({
      content:
        '笶� 譛牙柑縺ｪPayPay繝ｪ繝ｳ繧ｯ縺ｧ縺ｯ縺ゅｊ縺ｾ縺帙ｓ縲�\n`https://qr.paypay.ne.jp/...` 縺ｮ蠖｢蠑上〒豁｣縺励＞繝ｪ繝ｳ繧ｯ繧貞�蜉帙＠縺ｦ縺上□縺輔＞縲�',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // 繝ｪ繝ｳ繧ｯ蛻�ｌ繝ｻ驥鷹｡堺ｸ堺ｸ閾ｴ繝√ぉ繝�け
  const check = await checkPayPayLink(link, order.price);
  if (!check.ok) {
    return interaction.editReply({
      content: `笶� 縺薙�PayPay繝ｪ繝ｳ繧ｯ縺ｯ菴ｿ縺医∪縺帙ｓ縲�\n逅�罰: ${check.reason}\n\n豁｣縺励＞驥鷹｡搾ｼ�**${order.price}蜀�**�峨�譛牙柑縺ｪ繝ｪ繝ｳ繧ｯ繧偵√ｂ縺�ｸ蠎ｦ縲梧髪謇輔≧縲阪°繧蛾√ｊ逶ｴ縺励※縺上□縺輔＞縲Ａ,
    });
  }

  updateOrder(orderId, { paypayLink: link, status: 'awaiting_confirmation' });

  await interaction.editReply({
    content:
      '笨� PayPay繝ｪ繝ｳ繧ｯ繧貞女縺台ｻ倥￠縺ｾ縺励◆縲�\n蜈･驥代′遒ｺ隱阪〒縺肴ｬ｡隨ｬ縲∬�蜍輔〒驟埼√＠縺ｾ縺吶ゅ＠縺ｰ繧峨￥縺雁ｾ�■縺上□縺輔＞縲�',
  });

  const adminEmbed = new EmbedBuilder()
    .setTitle('縲仙�驥醍｢ｺ隱榊ｾ�■縲�')
    .setColor(0xfee75c)
    .addFields(
      { name: '豕ｨ譁⑩D', value: `\`${orderId}\`` },
      { name: '雉ｼ蜈･閠�', value: `<@${order.userId}>` },
      { name: '謨ｰ驥�', value: formatNumber(order.quantity) },
      { name: '謾ｯ謇暮｡�', value: `**${order.price}蜀�**` },
      { name: 'PayPay繝ｪ繝ｳ繧ｯ', value: link },
      { name: '繝ｪ繝ｳ繧ｯ繝√ぉ繝�け', value: '驥鷹｡堺ｸ閾ｴ繧堤｢ｺ隱肴ｸ医∩' }
    )
    .setTimestamp();

  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_confirm_${orderId}`)
      .setLabel('蜈･驥醍｢ｺ隱肴ｸ医∩ 竊� 驟埼�')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`admin_cancel_${orderId}`)
      .setLabel('繧ｭ繝｣繝ｳ繧ｻ繝ｫ')
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
    return interaction.reply({ content: '讓ｩ髯舌′縺ゅｊ縺ｾ縺帙ｓ縲�', ephemeral: true });
  }
  const orderId = interaction.customId.replace('admin_confirm_', '');
  const result = await deliverOrder(orderId, 'manual');
  if (!result.ok) {
    return interaction.reply({ content: result.error, ephemeral: true });
  }
  await interaction.update({
    content: `笨� 驟埼∝ｮ御ｺ� \`${orderId}\` / owo: ${result.owoOk ? '謌仙粥' : '螟ｱ謨励∪縺溘�譛ｪ險ｭ螳�'}`,
    embeds: [],
    components: [],
  });
}

async function handleAdminCancel(interaction) {
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({ content: '讓ｩ髯舌′縺ゅｊ縺ｾ縺帙ｓ縲�', ephemeral: true });
  }
  const orderId = interaction.customId.replace('admin_cancel_', '');
  updateOrder(orderId, { status: 'cancelled' });
  await interaction.update({
    content: `笶� 繧ｭ繝｣繝ｳ繧ｻ繝ｫ \`${orderId}\``,
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
  console.error('DISCORD_TOKEN 縺後≠繧翫∪縺帙ｓ');
  process.exit(1);
}

client
  .login(config.token)
  .then(() => startServer())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
