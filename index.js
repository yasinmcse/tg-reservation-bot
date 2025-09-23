import express from "express";
import { Telegraf } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN env değişkeni zorunlu.");
}

const bot = new Telegraf(BOT_TOKEN);

// --- Basit slot veri kaynağı (ileride DB ekleriz) ---
const SLOTS = ["10:00", "11:00", "14:00"];

bot.start((ctx) => ctx.reply("Merhaba! ✅ Randevu için /book yazabilirsin."));
bot.command("book", (ctx) => {
  const keyboard = SLOTS.map(s => [{ text: s, callback_data: `slot_${s}` }]);
  ctx.reply("Lütfen rezervasyon için uygun zamanı seçin ⏰", {
    reply_markup: { inline_keyboard: keyboard }
  });
});
bot.on("callback_query", (ctx) => {
  const slot = ctx.callbackQuery.data.replace("slot_", "");
  ctx.answerCbQuery();
  ctx.reply(`✅ Rezervasyonunuz alındı: ${slot}`);
});

// Express + Webhook
const app = express();
const secretPath = `/webhook/${BOT_TOKEN}`;
app.use(secretPath, bot.webhookCallback(secretPath));

app.get("/", (_, res) => res.send("Bot çalışıyor ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server ${PORT} portunda çalışıyor`);
});
