const { Client, GatewayIntentBits, Partials } = require('discord.js');
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

// 環境変数の読み込み
const PRICE_PER_100K = parseInt(process.env.PRICE_PER_100K) || 10; // 100kあたりの価格(円)
const MIN_PURCHASE = parseInt(process.env.MIN_PURCHASE) || 10000;  // 最低購入数

// 4つの配達用アカウントID（カンマ区切りで読み込み）
const DELIVERY_ACCOUNT_IDS = process.env.DELIVERY_ACCOUNT_IDS 
    ? process.env.DELIVERY_ACCOUNT_IDS.split(',').map(id => id.trim()) 
    : [];

let currentDeliveryIndex = 0; // 次に使用する配達アカウントのインデックス

client.once('ready', () => {
    console.log(`Botが正常に起動しました: ${client.user.tag}`);
});

app.post('/confirm-payment', async (req, res) => {
    const { secret, amount } = req.body;
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(403).send('Unauthorized');
    }

    try {
        const channel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
        
        // 入金通知テキストから金額（数字）を抽出
        const match = amount.match(/(\d[\d,]*)/);
        const yen = match ? parseInt(match[1].replace(/,/g, '')) : 0;

        if (yen <= 0) {
            if (channel) await channel.send(`⚠️ 金額の自動解析に失敗しました。受信内容: ${amount}`);
            return res.status(200).send('No amount parsed');
        }

        // 送金金額から OwO の数量を計算
        const owoAmount = Math.floor((yen / PRICE_PER_100K) * 100000);

        // 使用する配達アカウントを選択（登録がなければ管理者IDをフォールバック使用）
        let assignedDeliveryId = process.env.ADMIN_IDS;
        if (DELIVERY_ACCOUNT_IDS.length > 0) {
            assignedDeliveryId = DELIVERY_ACCOUNT_IDS[currentDeliveryIndex];
            // 次回の配達時は次のアカウントへ順番にローテーション（1->2->3->4->1...）
            currentDeliveryIndex = (currentDeliveryIndex + 1) % DELIVERY_ACCOUNT_IDS.length;
        }

        if (channel) {
            await channel.send(
                `💰 **入金を確認しました！**\n` +
                `・受領金額: ¥${yen.toLocaleString()}\n` +
                `・配達数量: ${owoAmount.toLocaleString()} OwO\n` +
                `・担当配達アカウント: <@${assignedDeliveryId}>\n\n` +
                `🚚 配達コマンドを送信中...`
            );

            // 送金コマンドの出力（指定された配達用アカウントから実行指示）
            await channel.send(`owo send <@${process.env.ADMIN_IDS}> ${owoAmount}`);
        }

        res.status(200).send('Success');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
