const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
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

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
const DELIVERY_ACCOUNT_IDS = process.env.DELIVERY_ACCOUNT_IDS ? process.env.DELIVERY_ACCOUNT_IDS.split(',') : [];
let deliveryIndex = 0;

client.once('ready', () => {
    console.log(`Logined as ${client.user.tag}`);
});

app.post('/confirm-payment', async (req, res) => {
    const { secret, amount } = req.body;
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(403).send('Unauthorized');
    }

    try {
        const channel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
        if (channel) {
            await channel.send(`💰 入金を確認しました: ¥${amount}`);
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
