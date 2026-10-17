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

const PRICE_PER_100K = parseInt(process.env.PRICE_PER_100K) || 6; 
const MIN_PURCHASE = parseInt(process.env.MIN_PURCHASE) || 1000000;  

const DELIVERY_ACCOUNT_IDS = process.env.DELIVERY_ACCOUNT_IDS 
    ? process.env.DELIVERY_ACCOUNT_IDS.split(',').map(id => id.trim()) 
    : [];

let currentDeliveryIndex = 0;

client.once('ready', async () => {
    console.log(`Botが正常に起動しました: ${client.user.tag}`);

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

client.on('interactionCreate', async interaction => {
    try {
        // 1. 「購入」ボタンを押したとき
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

        // 2. 数量を入力したとき
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

        // 3. 「支払う」ボタンを押したとき
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
                .setLabel(`¥${totalPrice}のPayPayリンク/共有文を入力`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://pay.paypay.ne.jp/...')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(payInput));
            await interaction.showModal(modal);
        }

        // 4. PayPayリンクを入力したときの検証
        else if (interaction.isModalSubmit() && interaction.customId.startsWith('pay_modal_')) {
            const parts = interaction.customId.split('_');
            const orderId = parts[2];
            const numVal = parseInt(parts[3]);
            const requiredPrice = parseInt(parts[4]);

            const payInput = interaction.fields.getTextInputValue('pay_link_input');

            // PayPayのリンク形式チェック
            if (!payInput.includes('pay.paypay.ne.jp')) {
                return interaction.reply({
                    content: '❌ **無効な入力です。**\nPayPayの正しい送金リンク（`https://pay.paypay.ne.jp/...`）を入力してください。',
                    ephemeral: true
                });
            }

            const buyer = interaction.user;

            await interaction.reply({ content: '✅ 支払いリンクを受け付けました！管理者が確認の上、配達を行います。', ephemeral: true });

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
                    `・支払請求額: ¥${requiredPrice}\n` +
                    `・PayPayリンク: ${payInput}\n` +
                    `・担当配達アカウント: <@${assignedDeliveryId}>\n\n` +
                    `🚚 **手動配達用コマンド:**\n` +
                    `\`owo send <@${buyer.id}> ${numVal}\``
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
