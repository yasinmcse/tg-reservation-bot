import express from "express";
import { Telegraf } from "telegraf";

const BOT_TOKEN = "8236706415:AAF9XXg4wqq6z6frtkdusbyNqV2C59O5Gz0";
const bot = new Telegraf(BOT_TOKEN);

// --- Slotlar ---
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

// --- Express + Webhook ---
const app = express();
const secretPath = "/webhook";

// 🔹 JSON body parser ekledik
app.use(express.json());

// 🔹 Telegram webhook endpoint
app.post(secretPath, bot.webhookCallback(secretPath));

app.get("/", (_, res) => res.send("Bot çalışıyor ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server ${PORT} portunda çalışıyor`);
});
