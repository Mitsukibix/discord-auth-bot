require("dotenv").config();
const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton, WebhookClient } = require("discord.js");
const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.DIRECT_MESSAGES,
    ],
    partials: ["CHANNEL", "GUILD_MEMBER", "MESSAGE", "USER", "REACTION"],
});

const mongoose = require("mongoose");
const express = require("express");
const axios = require("axios");
const path = require("path");
const AuthDatabase = require("./Schemas/AuthSchema");
const ownerIds = process.env.OWNER_IDS.split(",");

const app = express();
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => console.log("❌ Failed to connect to MongoDB", err));

client.login(process.env.TOKEN);

const webhook = new WebhookClient({ url: process.env.WEBHOOK_URL });

client.on("ready", async () => {
    console.log(`✅ Connected to ${client.user.username}`);
    await checkRevokedTokens();
    setInterval(checkRevokedTokens, 1 * 60 * 1000);
});

client.on("messageCreate", async (message) => {
    if (message.content === "!verify") {
        if (!ownerIds.includes(message.author.id)) return;
        const authLink = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify+guilds.join`;

        const embed = new MessageEmbed()
            .setColor("#FF69B4")
            .setDescription(`
### Access Server - Sunucuya Eriş!
\`\`\`
💋 Hmm... Bizi merak mı ediyorsun?  
🔥 İçeri girmek için doğrulamanı yap ve aramıza katıl!  
🔗 Aşağıdaki butona tıkla ve özel dünyamızın kapılarını aç...
\`\`\`
\`\`\`⚠️ Yetkilendirmeyi kaldırırsanız doğrulanmış rolünüz ve tüm ayrıcalıklarınız kaybolur!\n⚠️ If you remove authorization, your verified role and all privileges will be lost!\`\`\`
            `)
            .setImage("https://tenor.com/nXsF9720kVu.gif");

        const button = new MessageButton()
            .setLabel("✅ Doğrula - Verify")
            .setStyle("LINK")
            .setURL(authLink);

        const row = new MessageActionRow().addComponents(button);

        await message.channel.send({ embeds: [embed], components: [row] });
    }

    if (message.content.startsWith("!joined")) {
        if (!ownerIds.includes(message.author.id)) return;

        const args = message.content.split(" ");
        let guildId = args[1];

        if (!guildId) return message.reply("Guild Id");

        const users = await AuthDatabase.find();

        if (!users.length) {
            return message.reply("⚠️ Veritabanında doğrulanan hiç kullanıcı bulunamadı.");
        }

        let successCount = 0;
        let failCount = 0;

        for (const user of users) {
            try {
                let accessToken = user.accessToken;

                const tokenResponse = await axios.post(
                    "https://discord.com/api/oauth2/token",
                    new URLSearchParams({
                        client_id: process.env.CLIENT_ID,
                        client_secret: process.env.CLIENT_SECRET,
                        grant_type: "refresh_token",
                        refresh_token: user.refreshToken,
                    }).toString(),
                    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
                );

                accessToken = tokenResponse.data.access_token;
                await AuthDatabase.findOneAndUpdate(
                    { discordId: user.discordId },
                    { accessToken }
                );

                await axios.put(
                    `https://discord.com/api/guilds/${guildId}/members/${user.discordId}`,
                    { access_token: accessToken },
                    { headers: { Authorization: `Bot ${process.env.TOKEN}` } }
                );

                successCount++;
            } catch (error) {
                console.error(`Failed to add user ${user.discordId}: ${error.message}`);
                failCount++;
            }
        }

        const embed = new MessageEmbed()
            .setColor("#57F287")
            .setTitle("✅ Kullanıcılar Sunucuya Eklendi!")
            .setDescription(`**Toplam Kullanıcılar:** ${users.length}\n✅ **Başarıyla Eklenenler:** ${successCount}\n❌ **Başarısız Olanlar:** ${failCount}`)
            .setFooter({ text: "Doğrulama Sistemi", iconURL: client.user.displayAvatarURL() });

        await message.reply({ embeds: [embed] });

        webhook.send({
            content: `✅ **${successCount} kullanıcı** başarıyla sunucuya eklendi. ❌ **${failCount} kullanıcı** eklenemedi.`,
            username: "AuthBot"
        });
    }

    if (message.content === "!controlled") {
        if (!ownerIds.includes(message.author.id)) return;
        const validUsers = await AuthDatabase.find();
        message.reply(`✅ Şu an **${validUsers.length}** geçerli hesap bulunuyor.`);
    }
});

app.get("/", (req, res) => {
    res.send("Başarılı!");
});

app.get("/success", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("❌ Kod bulunamadı.");

    try {
        const tokenResponse = await axios.post(
            "https://discord.com/api/oauth2/token",
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: process.env.REDIRECT_URI,
                scope: "identify",
            }).toString(),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );

        const { access_token, refresh_token } = tokenResponse.data;

        const userResponse = await axios.get("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${access_token}` },
        });

        const { id, username, avatar, discriminator } = userResponse.data;
        const avatarURL = avatar
            ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
            : "https://cdn.discordapp.com/embed/avatars/0.png";

        await AuthDatabase.findOneAndUpdate(
            { discordId: id },
            { username, avatarURL, accessToken: access_token, refreshToken: refresh_token },
            { upsert: true, new: true }
        );

        const userDM = await client.users.fetch(id);
        await userDM.send(`✅ **${username}**, başarıyla doğrulandın! 🎉`);

        try {
            await axios.put(
                `https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${id}`,
                { access_token: access_token },
                { headers: { Authorization: `Bot ${process.env.TOKEN}` } }
            );

            await axios.put(
                `https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${id}/roles/${process.env.VERIFY_ROLE_ID}`,
                {},
                { headers: { Authorization: `Bot ${process.env.TOKEN}` } }
            );

            console.log(`✅ Kullanıcıya verify rolü verildi: ${username} (${id})`);
        } catch (err) {
            console.error(`❌ Kullanıcıya verify rolü eklenirken hata oluştu:`, err.response && err.response.data || err.message);
        }

        webhook.send({
            embeds: [await createEmbed({
                authorName: 'Doğrulama Başarılı!',
                authorIconURL: avatarURL,
                description: `<a:CHECK_CHECKBurst:1308875944748122173> **${username}** ( <@${id}> ) adlı kullanıcı başarıyla doğrulandı. Kullanıcıya **Verified Member** rolünü verdim.`,
                fields: [
                    {
                        name: 'Kullanıcı',
                        value: `\`\`\`${username}\`\`\``,
                        inline: true,
                    },
                    {
                        name: 'Kullanıcı ID',
                        value: `\`\`\`${id}\`\`\``,
                        inline: true,
                    }
                ],
                color: "#14ff58",
            })],
        }).catch(console.error);

        return res.redirect(`/success?username=${encodeURIComponent(username)}&avatarURL=${encodeURIComponent(avatarURL)}`);
    } catch (err) {
        console.error("❌ Doğrulama hatası:", err.response && err.response.data || err.message);
        res.status(500).send("❌ Bir hata oluştu.");
    }
});

async function checkRevokedTokens() {
    const users = await AuthDatabase.find();
    let validCount = 0;
    let revokedCount = 0;

    for (const user of users) {
        try {
            await axios.get("https://discord.com/api/users/@me", {
                headers: { Authorization: `Bearer ${user.accessToken}` }
            });
            validCount++;
        } catch (err) {
            console.log(`❌ Kullanıcı yetkilendirmeyi kaldırdı: ${user.username} (${user.discordId})`);
            revokedCount++;

            await AuthDatabase.deleteOne({ discordId: user.discordId });

            await axios.delete(
                `https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${user.discordId}/roles/${process.env.VERIFY_ROLE_ID}`,
                { headers: { Authorization: `Bot ${process.env.TOKEN}` } }
            );

            try {
                const userDM = await client.users.fetch(user.discordId);
                userDM.send("⚠️ Yetkilendirmeyi kaldırdığın için sunucudaki rolün kaldırıldı. Tekrar doğrulamak için <#1341744348068450305> kanalına bakabilirsin.");
            } catch (dmError) {
                console.log(`❌ **${user.username}** kullanıcısına DM gönderilemedi.`);
            }

            webhook.send({
                embeds: [await createEmbed({
                    authorName: 'Yetkilendirme Hatası!',
                    authorIconURL: user.avatarURL,
                    description: `<a:PLUS_MINUSBurst:1308875964956016700> **${user.username}** ( <@${user.discordId}> ) adlı kullanıcı yetkilendirmeyi kaldırdığı için kullanıcıdan **Verified Member** rolünü aldım.`,
                    fields: [
                        {
                            name: 'Kullanıcı',
                            value: `\`\`\`${user.username}\`\`\``,
                            inline: true,
                        },
                        {
                            name: 'Kullanıcı ID',
                            value: `\`\`\`${user.discordId}\`\`\``,
                            inline: true,
                        }
                    ],
                    color: "#ffc324",
                })],
            });

            console.log(`❌ **${user.username}** yetkilendirmesini kaldırdı, verify rolü alındı.`);
        }
    }

    console.log(`✅ Geçerli hesaplar: ${validCount}, ❌ Silinen hesaplar: ${revokedCount}`);
}

async function createEmbed(data = {}) {
    const embed = new MessageEmbed();

    if (data.authorName) {
        embed.setAuthor(data.authorName, data.authorIconURL || null);
    }

    if (data.title) embed.setTitle(data.title);
    if (data.url) embed.setURL(data.url);
    if (data.description) embed.setDescription(data.description);
    if (data.thumbnail) embed.setThumbnail(data.thumbnail);
    if (data.color) embed.setColor(data.color);

    if (Array.isArray(data.fields) && data.fields.length > 0) {
        embed.addFields(data.fields);
    }

    if (data.footerText) {
        embed.setFooter(data.footerText, data.footerIconURL || null);
    }

    if (data.timestamp === "yes") {
        embed.setTimestamp();
    }

    if (data.image && typeof data.image === "object" && data.image.data !== "no") {
        embed.setImage(data.image.image);
    }

    return embed;
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`✅ API çalışıyor: http://localhost:${port}`);
});