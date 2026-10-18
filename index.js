const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const https = require('https');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

const PRICE_PER_100K = parseInt(process.env.PRICE_PER_100K) || 6; 
const MIN_PURCHASE = parseInt(process.env.MIN_PURCHASE) || 1000000;  

const DELIVERY_USER_TOKENS = process.env.DELIVERY_USER_TOKENS 
    ? process.env.DELIVERY_USER_TOKENS.split(',').map(t => t.trim()).filter(t => t.length > 0) 
    : [];

let currentDeliveryIndex = 0;

async function sendOwoFromDeliveryAccount(channelId, buyerId, amount) {
    if (DELIVERY_USER_TOKENS.length === 0) {
        console.error('エラー: DELIVERY_USER_TOKENS が設定されていないか空です。');
        return false;
    }

    const token = DELIVERY_USER_TOKENS[currentDeliveryIndex];
    currentDeliveryIndex = (currentDeliveryIndex + 1) % DELIVERY_USER_TOKENS.length;

    const postData = JSON.stringify({
        content: `owo send <@${buyerId}> ${amount}`
    });

    const options = {
        hostname: 'discord.com',
        path: `/api/v9/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    console.log(`配達成功: ${amount} OwO を送信しました。`);
                    resolve(true);
                } else {
                    console.error(`配達失敗 HTTP Status: ${res.statusCode}, レスポンス: ${data}`);
                    resolve(false);
                }
            });
        });
        req.on('error', (e) => {
            console.error('配達リクエストエラー:', e);
            resolve(false);
        });
        req.write(postData);
        req.end();
    });
}

client.once('ready', async () => {
    console.log(`Botが正常に起動しました: ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton() && interaction.customId === 'open_purchase_modal') {
            const modal = new ModalBuilder()
                .setCustomId('purchase_modal')
                .setTitle('OwO 購入数量入力');

            const quantityInput = new TextInputBuilder()
                .setCustomId('quantity_input')
                .setLabel('購入する数量を入力してください')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例: 100万 / 1m / 1000000')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(quantityInput));
            await interaction.showModal(modal);
        }
        else if (interaction.isModalSubmit() && interaction.customId === 'purchase_modal') {
            const inputVal = interaction.fields.getTextInputValue('quantity_input');
            
            let num = parseInt(inputVal.replace(/[^0-9]/g, '')) || 0;
            if (inputVal.toLowerCase().includes('m')) num *= 1000000;
            if (inputVal.includes('万')) num *= 10000;

            if (num < MIN_PURCHASE) {
                return interaction.reply({ content: `⚠️ 最低購入量は ${MIN_PURCHASE.toLocaleString()} 以上です。`, ephemeral: true });
            }

            const totalPrice = Math.ceil((num / 100000) * PRICE_PER_100K);
            const orderId = Math.random().toString(36).substring(2, 10);

            const embed = new EmbedBuilder()
                .setTitle('購入内容を確保しました。')
                .setDescription(
                    `**注文ID:** \`${orderId}\`\n` +
                    `**送信先:** <@${interaction.user.id}> (購入者本人)\n` +
                    `**数量:** ${num.toLocaleString()} OwO\n` +
                    `**支払額:** ${totalPrice}円\n\n` +
                    `⚠️ **【購入前の注意点】**\n` +
                    `ご自身のOwO所持上限・銀行上限を超えていないか確認してください。上限に達していると受け取りに失敗する場合があります。\n\n` +
                    `⏱️ **2分以内に支払いを完了してください。**\n` +
                    `下の **支払う** から¥${totalPrice}のPayPay送金リンクを入力してください。`
                )
                .setColor(0x00FF00);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`pay_${orderId}_${num}_${totalPrice}`)
                    .setLabel('支払う')
                    .setStyle(ButtonStyle.Success)
            );

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
        else if (interaction.isButton() && interaction.customId.startsWith('pay_')) {
            const parts = interaction.customId.split('_');
            const orderId = parts[1];
            const num = parts[2];
            const totalPrice = parts[3];

            const modal = new ModalBuilder()
                .setCustomId(`pay_modal_${orderId}_${num}_${totalPrice}`)
                .setTitle('PayPay送金リンク入力');

            const payInput = new TextInputBuilder()
                .setCustomId('pay_link_input')
                .setLabel(`¥${totalPrice}のPayPayリンクを入力`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://pay.paypay.ne.jp/XXXXXX')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(payInput));
            await interaction.showModal(modal);
        }
        else if (interaction.isModalSubmit() && interaction.customId.startsWith('pay_modal_')) {
            const parts = interaction.customId.split('_');
            const orderId = parts[2];
            const numVal = parseInt(parts[3]);
            const requiredPrice = parseInt(parts[4]);

            const payInput = interaction.fields.getTextInputValue('pay_link_input').trim();

            const paypayRegex = /^https:\/\/pay\.paypay\.ne\.jp\/[a-zA-Z0-9]+$/;
            if (!paypayRegex.test(payInput)) {
                return interaction.reply({
                    content: '❌ **有効なPayPayリンクではありません。**\n`https://pay.paypay.ne.jp/XXXXXX` の形式で正しいリンクを入力してください。',
                    ephemeral: true
                });
            }

            const buyer = interaction.user;

            await interaction.reply({ content: '✅ 支払いリンクを受け付けました！入金確認後に自動配達が行われます。', ephemeral: true });

            const channel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setTitle('🛒 新しい注文が入りました')
                    .setDescription(
                        `・**注文ID:** \`${orderId}\`\n` +
                        `・**購入者:** <@${buyer.id}>\n` +
                        `・**数量:** ${numVal.toLocaleString()} OwO\n` +
                        `・**請求金額:** ${requiredPrice}円\n` +
                        `・**PayPayリンク:** ${payInput}`
                    )
                    .setColor(0xFEE75C);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_deliver_${buyer.id}_${numVal}`)
                        .setLabel('入金確認＆自動配達実行')
                        .setStyle(ButtonStyle.Success)
                );

                await channel.send({ embeds: [embed], components: [row] });
            }
        }
        else if (interaction.isButton() && interaction.customId.startsWith('approve_deliver_')) {
            const parts = interaction.customId.split('_');
            const buyerId = parts[2];
            const numVal = parseInt(parts[3]);

            await interaction.deferUpdate();

            const success = await sendOwoFromDeliveryAccount(interaction.channelId, buyerId, numVal);

            if (success) {
                await interaction.followUp({ 
                    content: `✅ <@${buyerId}> への ${numVal.toLocaleString()} OwO の自動配達コマンドを発行しました！\n` +
                             `※受け取り側（<@${buyerId}>）の所持上限・受け取りエラー等でOwO Bot側でキャンセルされた場合は、購入者様の容量調整後に再度実行してください。` 
                });
            } else {
                await interaction.followUp({ 
                    content: `🚨 **【配達アカウントエラー】**\n` +
                             `配達用アカウントからのメッセージ送信に失敗しました。\n` +
                             `・配達アカウントのOwO所持金/残高不足\n` +
                             `・配達アカウントの送信制限・トークン無効\n` +
                             `上記を確認してください。` 
                });
            }
        }
    } catch (error) {
        console.error('インタラクション処理エラー:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);
