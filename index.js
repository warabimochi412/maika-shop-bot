const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
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

const app = express();
app.use(express.json());

// 設定価格と最低購入数（100kあたりの価格、最低購入量）
const PRICE_PER_100K = parseInt(process.env.PRICE_PER_100K) || 6; 
const MIN_PURCHASE = parseInt(process.env.MIN_PURCHASE) || 1000000;  

// 配達用アカウントIDの読み込み
const DELIVERY_ACCOUNT_IDS = process.env.DELIVERY_ACCOUNT_IDS 
    ? process.env.DELIVERY_ACCOUNT_IDS.split(',').map(id => id.trim()) 
    : [];

let currentDeliveryIndex = 0;

client.once('ready', async () => {
    console.log(`Botが正常に起動しました: ${client.user.tag}`);

    // 起動時にショップチャンネルに自販機パネルを送信
    try {
        const channel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
        if (channel) {
            const embed = new EmbedBuilder()
                .setTitle('OwO Cowoncy 自販機')
                .setDescription('下のボタンから購入数量を入力してください。送信先は購入者本人に固定されます。')
                .addFields(
                    { name: '価格', value: `${PRICE_PER_100K}円 / 10万`, inline: true },
                    { name: '最低購入量', value: `${MIN_PURCHASE.toLocaleString()}`, inline: true },
                    { name: '購入単位', value: '1万刻み', inline: true }
                )
                .setColor(0x5865F2);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('open_purchase_modal')
                    .setLabel('購入')
                    .setStyle(ButtonStyle.Primary)
            );

            await channel.send({ embeds: [embed], components: [row] });
            console.log('自販機パネルを送信しました。');
        }
    } catch (e) {
        console.error('自販機パネルの送信に失敗しました:', e);
    }
});

// ボタンやモーダルのインタラクション処理
client.on('interactionCreate', async interaction => {
    try {
        // 1. 「購入」ボタンが押されたとき
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

        // 2. 数量入力モーダルが送信されたとき
        else if (interaction.isModalSubmit() && interaction.customId === 'purchase_modal') {
            const inputVal = interaction.fields.getTextInputValue('quantity_input');
            
            // 入力値から数字を簡易抽出（簡易パース）
            let num = parseInt(inputVal.replace(/[^0-9]/g, '')) || 0;
            if (inputVal.toLowerCase().includes('m')) num *= 1000000;
            if (inputVal.includes('万')) num *= 10000;

            if (num < MIN_PURCHASE) {
                return interaction.reply({ content: `⚠️ 最低購入量は ${MIN_PURCHASE.toLocaleString()} 以上です。`, ephemeral: true });
            }

            // 金額の計算（100kあたりPRICE_PER_100K円）
            const totalPrice = Math.ceil((num / 100000) * PRICE_PER_100K);
            const orderId = Math.random().toString(36.substring(2, 15)) + Math.random().toString(36).substring(2, 15);

            // 「支払う」ボタン付きの注文確認メッセージを表示（自分だけにみえる ephemeral）
            const embed = new EmbedBuilder()
                .setTitle('購入内容を確保しました。')
                .setDescription(
                    `**注文ID:** \`${orderId}\`\n` +
                    `**送信先:** <@${interaction.user.id}> (購入者本人)\n` +
                    `**数量:** ${num.toLocaleString()} OwO\n` +
                    `**支払額:** ${totalPrice}円\n\n` +
                    `⏱️ **2分以内に支払いを完了してください。**\n` +
                    `下の **支払う** からPayPay送金リンクを入力してください。`
                )
                .setColor(0x00FF00);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`pay_${orderId}_${num}`)
                    .setLabel('支払う')
                    .setStyle(ButtonStyle.Success)
            );

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // 3. 「支払う」ボタンが押されたとき（PayPayリンク入力モーダルを表示）
        else if (interaction.isButton() && interaction.customId.startsWith('pay_')) {
            const [, orderId, num] = interaction.customId.split('_');

            const modal = new ModalBuilder()
                .setCustomId(`pay_modal_${orderId}_${num}`)
                .setTitle('PayPay送金リンク入力');

            const payInput = new TextInputBuilder()
                .setCustomId('pay_link_input')
                .setLabel('PayPayのリンク、または共有文を貼り付け')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://pay.paypay.ne.jp/...')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(payInput));
            await interaction.showModal(modal);
        }

        // 4. PayPayリンク入力モーダルが送信されたとき（管理者・ショップチャンネルへ通知）
        else if (interaction.isModalSubmit() && interaction.customId.startsWith('pay_modal_')) {
            const [, , orderId, num] = interaction.customId.split('_');
            const payLink = interaction.fields.getTextInputValue('pay_link_input');
            const buyer = interaction.user;

            const numVal = parseInt(num);
            const totalPrice = Math.ceil((numVal / 100000) * PRICE_PER_100K);

            await interaction.reply({ content: '✅ 支払いリンクを受け付けました！確認して配達を手配します。', ephemeral: true });

            // ショップチャンネルに注文情報とPayPayリンクを通知
            const channel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
            if (channel) {
                let assignedDeliveryId = process.env.ADMIN_IDS;
                if (DELIVERY_ACCOUNT_IDS.length > 0) {
                    assignedDeliveryId = DELIVERY_ACCOUNT_IDS[currentDeliveryIndex];
                    currentDeliveryIndex = (currentDeliveryIndex + 1) % DELIVERY_ACCOUNT_IDS.length;
                }

                await channel.send(
                    `🛒 **新しい注文が入りました！**\n` +
                    `・注文ID: \`${orderId}\`\n` +
                    `・購入者: <@${buyer.id}>\n` +
                    `・数量: ${numVal.toLocaleString()} OwO\n` +
                    `・支払額: ¥${totalPrice}\n` +
                    `・PayPayリンク: ${payLink}\n` +
                    `・担当配達アカウント: <@${assignedDeliveryId}>\n\n` +
                    `🚚 配達コマンドを準備中...\n` +
                    `owo send <@${buyer.id}> ${numVal}`
                );
            }
        }
    } catch (error) {
        console.error('インタラクション処理エラー:', error);
        if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({ content: '⚠️ エラーが発生しました。もう一度お試しください。', ephemeral: true }).catch(() => {});
        }
    }
});

// 外部Webhookからの自動通知用エンドポイント（必要に応じて）
app.post('/confirm-payment', async (req, res) => {
    const { secret, amount } = req.body;
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(403).send('Unauthorized');
    }
    res.status(200).send('Success');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
